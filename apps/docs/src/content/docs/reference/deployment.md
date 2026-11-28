---
title: 部署 Hive 服务
description: 在个人电脑、局域网或云服务器（HTTPS 反向代理后）部署 SuperHive，配置监听地址与持久数据，理解本机 Agent、身份授权、备份和更新的边界。
---

## 先选一种使用方式

从零搭建团队共用的云服务器，请按[云端部署与多人共用指南](/guides/cloud-deployment/)操作；本页保留监听、身份、数据与更新的参考说明。

| 场景                       | 推荐起点                              | 你需要注意                                                  |
| -------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| 只在自己的电脑使用         | 本机启动，浏览器访问回环地址          | Agent 所需 CLI 仍需安装并登录                               |
| 同一局域网多人协作         | Server 保持运行，其他人通过邀请加入   | 防火墙、设备身份、访问授权                                  |
| 异地或手机访问             | 云服务器加 HTTPS 反向代理，或可信 VPN | TLS、凭据、网络可达性和代理头                               |
| 只公开文档，不公开协作房间 | 单独部署 `apps/docs`                  | 看[文档站部署](/reference/documentation/)，不需要 Hive 服务 |

Hive Server 存储房间数据并协调消息。Agent 可以与它同机，也可以在另一台设备上接入；**Server 能联网不代表能访问另一台设备的文件**。

![部署架构示意：浏览器与 IM 经网络访问 Hive Server，Agent 在各自设备通过 Bridge 接入，本机工作区与私有会话不属于共享数据库。非实际界面截图。](/media/architecture/deployment.svg)

图为部署模型示意，不是实际服务或管理界面截图。

## 启动与监听地址

需要 Node.js **22.12+**；普通使用不需要克隆源码。推荐全局安装，分两步（不想全局安装时把 `hive` 换成 `npx superhive`）：

1. **安装**（每台电脑只需一次，装好后就有了 `hive` 命令）：

   ```bash
   npm i -g superhive
   ```

2. **运行**（启动 Hive Server 并打开网页，以后每次启动都用这一条）：

   ```bash
   hive
   ```

默认后台启动，监听 `0.0.0.0:8787`，数据保存在当前用户的 `~/.superhive/`。终端会给出 Web UI 地址；本机浏览器通常自动打开回环地址。

`0.0.0.0` 表示监听所有网络接口，不是浏览器地址，也不是“只允许本机”。如果暂时只供本机或同机代理访问，可明确限制监听：

```bash
hive --host 127.0.0.1 --no-open
```

需要不同端口、专用数据目录或前台日志，可用 `--port`、`--data-dir`、`--foreground`；完整参数见 [CLI 参考](/reference/cli/)。本文描述源码基线的能力，npm 已发布版本可能存在时间差，以实际版本和界面为准。

## 局域网与异地 Agent

其他设备使用 Server 实际可达的地址，而不是 `127.0.0.1`。房主先创建[房间与限时邀请](/guides/rooms/)，再让成员加入；另一台电脑的 Agent 在那台电脑安装、登录对应 CLI，并执行向导生成的接入命令。

**邀请链接、共享 Join Token 和房主设备身份不是一回事**。共享 Join Token 是高信任房主级凭据，只给受信任的 Agent 使用，不能当普通单房间邀请码分发。访客应使用专用的邀请与接入流程，设备登录票不用于 Agent 接入；任何带凭据的完整命令都不要贴到公共房间。

家用路由器、防火墙、VPN 和平台网络策略可能阻止访问。优先排查网络和地址，不要为了“先连上”直接关闭鉴权、放开全部端口或授予完全访问。

## HTTPS 反向代理

下面是 Nginx **转发部分的示例**，不是可直接上公网的完整配置。你仍需自行配置证书、TLS 监听、域名和访问策略；示例域名必须替换。

先让 Hive 仅监听回环，并生成正确的对外链接；不需要在 Server 所在电脑运行 Agent 时，可以关闭网页本机启动能力：

```bash
hive \
  --host 127.0.0.1 \
  --public-url https://hive.your-domain.com \
  --no-local-agents \
  --no-open
```

当前 `--no-local-agents` 也会关闭房主设备配对和管理入口；首次配对时先不要加它，关闭后新增或撤销设备也需重新启用。步骤见[云端指南的 SSH 隧道登录](/guides/cloud-deployment/#2-用-ssh-隧道成为房主)。

Nginx 的对应 HTTPS `server` 中添加：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

网页需要 WebSocket，Agent 还需要 HTTP / MCP。只代理首页而不代理这些连接，可能出现“网页能打开但成员离线”。代理和外层平台还需允许你的附件大小及较长的连接时长。

:::caution[不要把公网请求伪装成本机请求]
保留原始公网 Host / Origin 和代理来源信息。不要为了让本机管理按钮可用而将它们重写成 localhost，或删除来源检查。远程房主应使用设备登录与管理授权；本机能力本来就有额外限制。
:::

这个示例没有在你的网络、证书或云平台运行过；上线前逐项验证[安全边界](/reference/security/)、WebSocket 重连、附件以及远程 Agent。

## 数据与备份

启动参数中的数据目录必须放在持久磁盘。容器或临时主机重建时，如果没有保存它，消息、房间和相关配置可能丢失。

备份时至少考虑：公共数据库、附件、认证与加密相关文件、本机 Agent 的配置。**整个目录都应按敏感凭据保护**，不能上传到文档站、公开仓库或公共房间。

最容易理解的一致性备份流程是：

1. 告知团队并等待或停止正在执行的任务，先核对外部副作用。
2. 用 `hive stop` 正常停止 Server；自定义数据目录时带上同一个 `--data-dir`。
3. 将完整数据目录复制到受保护的备份位置，而不是只拷贝正在写入的 SQLite 主文件。
4. 按原配置重新启动；定期在隔离环境演练恢复。

服务器备份不会自动备份每台 Agent 设备的项目文件、Git 历史或 Provider 私有会话。恢复到新设备时，也不能假定旧路径、CLI 登录和本机 Agent 配置都能继续使用。

## 更新、重启与持续运行

- 只检查有没有新版本：

  ```bash
  hive update --check
  ```

- 用原来的包管理器装到最新版，运行中的 Server 自动用新版本重启：

  ```bash
  hive update
  ```

- 只重启当前版本：

  ```bash
  hive restart
  ```

`hive update` 和 `hive restart` 都会沿用保存的启动配置，`restart` 显式传入的参数可覆盖它。重启时本机 Agent 由新 Server 接管，正在跑的任务不中断；交接不了又有任务在跑时会先问你等还是中断，脚本里默认等，`--force` 立即重启，详见 [CLI 参考](/reference/cli/#更新和新版本提示)。用 npx 运行时没有 `hive update`，改用 `npx superhive@latest restart`。对重要环境，先备份、核对发布说明并在隔离环境验证，再更新生产；不要把开发热重载当作发布流程。

全局安装后可用 `hive autostart on` 设置登录自启，`hive autostart status` 核对状态；`hive update` 后路径不变，一般不用重新开启。自启动不是对一切关机、睡眠或网络问题的高可用保证。长期服务建议用持续在线的设备和明确的进程管理策略。

Server / Agent 重启、崩溃后的任务恢复规则不同，详见[任务状态与安全恢复](/guides/tasks/)。不要用频繁重启代替排查，也不要因为看到“结果未知”就重复执行有外部副作用的任务。
