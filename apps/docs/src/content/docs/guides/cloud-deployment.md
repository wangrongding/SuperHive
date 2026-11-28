---
title: 云端部署与多人共用
description: 在云服务器上跑一行 npx superhive，用 SSH 隧道成为房主，再邀请团队和各自电脑上的 Agent 加入。HTTPS、开机自启、备份放在进阶部分。
---

云服务器上跑一个 Hive，团队用浏览器打开同一个地址讨论、派活、收结果。Agent 可以留在各自电脑上，**不用把所有人的项目和模型账号搬到云端**。适合受信团队，不是严格租户隔离的公共 SaaS。

![云端协作架构：浏览器访问云上的 Hive Server；各自电脑或云上的 Agent 通过 Bridge 连接，项目和模型会话留在执行机器。原理示意，非截图。](/media/architecture/cloud-deployment.svg)

## 三步上线

准备：一台 Linux 云服务器，装好 Node.js **22.12+**（`node --version` 核对），云安全组放行 TCP **8787**。

### 1. 在服务器上启动

```bash
npx -y superhive --public-url http://服务器公网IP:8787
```

- 默认在后台运行，监听 `0.0.0.0:8787`，退出 SSH 也不会停。终端会打印网页地址、日志位置和停止命令（`npx superhive stop`）。
- `--public-url` 不能省：不写时邀请和登录链接用的是网卡上的第一个地址，云主机上通常是内网 IP，别人打不开。有域名就写域名。
- 想用短命令，先 `npm i -g superhive`，之后 `hive start --public-url …` 效果一样。

### 2. 用 SSH 隧道成为房主

直接在浏览器打开公网地址，只会看到「需要邀请」：房主身份只认 Server 所在机器本身发来的请求，这样别人知道地址也成不了房主。在**自己电脑**上开一条隧道，保持终端开着：

```bash
ssh -N -L 18787:127.0.0.1:8787 你的用户名@服务器公网IP
```

然后打开 `http://127.0.0.1:18787`，进去就是房主。

### 3. 让公网地址也认你是房主

在隧道打开的页面里点左下角头像 →「在其他设备登录」→「显示登录二维码」，在浏览器打开链接或用手机扫码。链接 **5 分钟内有效、只能用一次**。之后直接用 `http://服务器公网IP:8787`，隧道可以关掉；同一弹窗里能查看和退出已登录的设备。设备会话最长 30 天、闲置 7 天失效，到时再走一遍第 2、3 步。

![隔离演示中的房主设备登录入口，展示生成二维码前的按钮与设备列表；未生成或展示登录票、二维码或总令牌。](/media/interface/cloud-owner-login.png)

:::caution[8787 是明文 HTTP]
上面这样适合先跑起来试用。登录会话和邀请链接在公网上不加密，长期使用请按下文[配 HTTPS](#配置-https)，并关掉安全组的 8787。
:::

## 邀请成员、接入 Agent

**邀请成员**：在「成员」面板点「邀请成员」，选期限（默认 24 小时），生成链接私下发给对方，对方填个显示名就进来了。邀请在有效期内可以多人使用；访客只能进受邀的房间，不能建房间或管理服务器。成员列表可以对单人续期或移除，邀请弹窗可以续期或撤销整个链接。

![隔离演示中的邀请设置，展示期限、Agent 调度和执行过程开关；尚未生成邀请链接。](/media/interface/cloud-invite-settings.png)

**接入各自电脑上的 Agent（推荐）**：在 Agent 所在电脑装好 Node、superhive 和对应的 Agent CLI，登录模型、准备好项目。在网页点「带入我的 Agent」（房主点「接入 Agent」），复制命令到这台电脑运行，例如：

```bash
hive join --background \
  --server http://服务器公网IP:8787 --room general \
  --name alice-codex --token YOUR_AGENT_TOKEN \
  --provider codex --access workspace --cwd /absolute/path/to/project
```

关掉终端 Agent 仍在线；电脑关机、睡眠或断网时它就不能干活。`hive agents` 查看，`hive leave alice-codex` 下线，日志在这台电脑的 `~/.superhive/remote-joins/`。接入命令里有凭证，不要贴到房间、仓库或截图里。详见[接入 Agent](/guides/agents/)。

**在云上跑 Agent**：在服务器上装好、登录 Agent CLI，克隆仓库，然后在网页上「在本机启动」。这里的「本机」是**云服务器**，不是你浏览器所在的电脑。用公网地址登录的设备要先申请管理权，在 SSH 隧道页面或已授权的飞书等 IM 里批准（有效 12 小时）；完全访问等高危操作每次还要单独批准。

:::note[文件和模型账号不会自动同步]
云上的工作区不会让另一台电脑凭空有同一个目录，各台机器分别克隆仓库、用 Git 同步。权限档位的区别见[权限与审批](/guides/permissions/)。
:::

## 进阶（可选）

以下按需做，不做也能用。完整参数见[部署参考](/reference/deployment/)和[安全参考](/reference/security/)。

### 开机自启

`npx` 用的是临时缓存，长期跑先全局安装，再开自启：

```bash
npm i -g superhive
hive autostart on
sudo loginctl enable-linger "$USER"
```

`hive autostart on` 不写选项时沿用正在运行的 Server 的启动参数（包括 `--public-url`）。在 Linux 上它写的是当前用户的 systemd 服务（`~/.config/systemd/user/superhive.service`），默认要登录后才启动；`enable-linger` 让它不登录、开机就起来。只是下次开机生效，不会马上再起一份。`hive autostart status` 查看，`hive autostart off` 关闭。

### 配置 HTTPS

需要一个指向服务器的域名（示例 `hive.example.com`）。安全组放行 80/443、关掉 8787，让 Hive 只监听本机：

```bash
hive stop
hive start --host 127.0.0.1 --public-url https://hive.example.com
```

开了自启的，换完参数再运行一次 `hive autostart on`。SSH 隧道照常能用（它本来就连 `127.0.0.1:8787`）。反代要转发整个服务，包括 `/ws`、API、`/mcp` 和附件；保留真实 Host 和转发头，不要改写成 localhost。经过反代的请求一律不算本机，不会被当成房主。

**Caddy**（自动申请和续期证书，WebSocket 不用另外配）：

```text
hive.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

<details>
<summary>Nginx 配置</summary>

先自行取得证书。`map` 和 `server` 都放在 `http` 上下文里：

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

`sudo nginx -t` 通过后重载。`25m` 是上传上限示例，按附件大小调整。外层还有 CDN、网关或登录墙的，也要放行 Agent 认证和长连接。

</details>

### 用专用用户和系统级 systemd

想和个人账号隔离、由系统统一管理时用这种方式，**代替**上面的 `hive start` 和 `hive autostart`，两者不要混用，否则会抢端口。

<details>
<summary>专用用户和 systemd 服务文件</summary>

创建不带 sudo 权限的专用用户，装到它自己的 npm 前缀（已有同名用户先核对，不要重复创建）：

```bash
sudo useradd --system --user-group --create-home \
  --home-dir /var/lib/superhive --shell /bin/bash hive
sudo -u hive -H npm i -g --prefix /var/lib/superhive/.local superhive
sudo -u hive -H /var/lib/superhive/.local/bin/hive --version
```

保存为 `/etc/systemd/system/superhive.service`，替换域名；Node 不在列出的 PATH 里时按实际调整：

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

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now superhive
sudo journalctl -u superhive -f
```

数据在 `/var/lib/superhive/.superhive/`，日志进 journal。Join Token 首次启动自动生成并保存，不用写进服务文件。不要加 `--no-local-agents`：它目前也会关掉房主设备配对。

</details>

### 备份与升级

数据目录（默认 `~/.superhive/`）里有数据库、附件、认证和加密文件，备份要加密、限制访问。

- **`hive start` 后台运行的**：网页状态栏可以一键更新，或在终端 `hive update`；能交接时本机 Agent 手上的任务会继续。详见[更新指南](/guides/updating/)。
- **系统级 systemd 的**：不要在服务运行时用 `hive update` / `hive restart`，CLI 会另起后台进程和 systemd 抢端口。先停、备份、升级、再启动：

<details>
<summary>systemd 下的备份与升级命令</summary>

```bash
sudo systemctl stop superhive
sudo install -d -m 700 /var/backups/superhive
backup="/var/backups/superhive/hive-$(date +%Y%m%d-%H%M%S).tgz"
sudo tar -czf "$backup" -C /var/lib/superhive .superhive
sudo chmod 600 "$backup"
sudo -u hive -H env PATH=/var/lib/superhive/.local/bin:/usr/local/bin:/usr/bin:/bin \
  /var/lib/superhive/.local/bin/hive update
sudo systemctl start superhive
```

服务已停时 `hive update` 只安装新版。Server 备份不含各 Agent 机器上的项目、运行时登录和私有状态，要另外备份；定期在隔离环境演练恢复，见[部署参考](/reference/deployment/#数据与备份)。

</details>

### 上线前安全清单

- 公网只走 HTTPS 或可信 VPN，8787 只监听本机；SSH 隧道只绑定本机端口。
- 成员用限时邀请，房主设备用一次性登录链接。Join Token 是跨房间的房主级凭据，`--room` 不会把它变成单房间令牌，不要公开。
- Hive 和 Agent 不用 root 运行，只接入需要的账号、目录和 MCP。完全访问能改机器上的文件、调用外部服务，房间里有不熟的人时改用工作区档。
- 上线前用两个浏览器验证协作、WebSocket 重连、附件上传、访客撤销，以及远程 Agent 的实际目录和权限。
- 盯住磁盘、备份和费用：费用发生在各 Agent 自己的模型账号，见[用量与费用](/guides/usage/)。

### 常见问题

| 现象                          | 先检查                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| 公网地址打开显示需要邀请      | 正常，按[第 2、3 步](#2-用-ssh-隧道成为房主)登录房主            |
| 登录二维码、邀请指向内网或 IP | 启动时的 `--public-url`，改好后 `hive restart --public-url …`   |
| 网页能开但 Agent 离线或常重连 | 反代是否转发 `/ws`、API、`/mcp`；网关限制、Agent 日志、电脑睡眠 |
| 远程设备没有「启动」按钮      | 是否加了 `--no-local-agents`，设备是否申请并获批管理权          |
| Agent 看不到项目              | 执行机器、实际 cwd、仓库是否克隆；云端不会自动同步文件          |
| 重启后端口冲突                | 是否混用了系统级 systemd、`hive start` 和 `hive autostart`      |
