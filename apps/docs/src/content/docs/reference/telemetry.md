---
title: 使用统计：收什么、不收什么、怎么关
description: SuperHive 默认记录匿名、粗粒度的使用统计。本页列出全部字段和事件、怎么查看和关闭、数据保留多久，以及我们承诺不收的数据。
---

SuperHive 默认开启匿名使用统计：只记版本、系统、用到了哪些功能、更新成没成功这类粗粒度的数，用来判断先修什么、先做什么。**不收消息、路径、名字和 key**，随时可以关。做法参照 Next.js 和 Homebrew：默认开、第一次告诉你、一个开关或一个环境变量就能关。

:::note[发到哪里]
npm 安装和桌面版默认发到项目自部署的 [Umami](https://umami.is)：`https://60.205.92.58`。从源码运行（仓库里 `pnpm dev`、自己 build 出来的、没打包的桌面端）默认不发，只记在这台电脑上；要发得显式设 `SUPERHIVE_TELEMETRY_URL`，见[上报和保留](#上报和保留)。
:::

## 怎么关

任选一种：

- 网页「设置 → 这台电脑 → 匿名使用统计」关掉开关。只有 Server 所在电脑上的房主能改，其他设备上只能看。
- 第一次启动时右下角会弹一张卡片说明这件事，点「关闭统计」。卡片只弹一次。
- 终端运行 `hive telemetry off`，打开用 `hive telemetry on`，`hive telemetry status` 查看当前状态。
- 启动前设环境变量 `SUPERHIVE_TELEMETRY=0`（也认 `false`、`off`），或通用的 `DO_NOT_TRACK=1`。

下面这些情况一律不记，不用手动关：CI 环境（`CI`、`GITHUB_ACTIONS`、`GITLAB_CI`、`BUILDKITE`、`JENKINS_URL` 等）、沙箱预览（`HIVE_SANDBOX=1`）、跑测试时（`NODE_ENV=test`、`VITEST`）。

关掉后不再记录，**还没发出去的数据当场删掉**。环境变量挡住时连本机文件也不建。

## 怎么看要发什么

- 网页「设置 → 这台电脑 → 匿名使用统计」点「查看要发送的数据」，显示下一次要发给统计服务的原始 JSON。
- 终端运行 `hive telemetry preview`，内容和网页一样。

统计服务是自部署的 [Umami](https://umami.is)，一条事件就是它的一条 `event`。请求体长这样（一个数组，一次最多 50 条）：

```json
[
  {
    "type": "event",
    "payload": {
      "website": "b2d13ec6-3fa6-47bf-9cbd-7317357517fc",
      "hostname": "superhive.app",
      "url": "/heartbeat",
      "name": "heartbeat",
      "language": "zh-CN",
      "timestamp": 1795838400,
      "id": "8d0f3c1e-2a4b-4c6d-8e9f-0a1b2c3d4e5f",
      "data": {
        "schema": 1,
        "version": "0.4.9",
        "runMode": "npm",
        "os": "darwin",
        "arch": "arm64",
        "locale": "zh-CN",
        "agents_claude": 2,
        "agents_codex": 1,
        "rooms": "2-5"
      }
    }
  }
]
```

请求头只有 `Content-Type: application/json` 和 `User-Agent: SuperHive/0.4.9 (darwin; arm64)`（版本、系统、CPU 架构），没有 Cookie 和别的标识。

## 公共字段

每条事件都带这些：

| 字段                | 内容                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `payload.id`        | 安装 ID：第一次启动时随机生成，和电脑、账号无关；可在设置里或 `hive telemetry reset` 重置 |
| `payload.timestamp` | 事件发生的时间（Unix 秒），只精确到小时（UTC）                                            |
| `payload.name`      | 事件名，见下面「事件」；`payload.url` 是 `/` 加事件名                                     |
| `payload.language`  | 界面语言：`zh-CN` 或 `en`，其它语言不带这一项                                             |
| `payload.website`   | 固定值：统计服务里 SuperHive 这个站点的 ID；`payload.hostname` 也是固定的 `superhive.app` |
| `data.schema`       | 数据格式版本，现在是 `1`                                                                  |
| `data.version`      | SuperHive 版本号，例如 `0.4.9`                                                            |
| `data.runMode`      | 运行方式：`npm`（npm 全局安装）、`desktop`（桌面端）、`source`（源码）                    |
| `data.os`           | 操作系统：`darwin`、`win32`、`linux`、`other`                                             |
| `data.arch`         | CPU 架构：`x64`、`arm64`、`other`                                                         |
| `data.locale`       | 界面语言：`zh-CN`、`en`、`other`                                                          |

## 事件

各事件自己的字段也放在 `data` 里，只有一层；计数类的字段拍成「字段\_类别」，例如 `agents_claude`。所有字段都只能取下面列出的值；不认得的字段、不在范围里的值在记录前就丢掉，整条事件缺了必填字段也丢掉。

### `heartbeat`：每天一次

| 字段     | 内容                                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents` | 本机 Agent 按 CLI 类型分的个数，拍成 `agents_类型`，类型只有 `codex`、`claude`、`copilot`、`opencode`、`omp`、`openclaw`、`gemini`、`agy`；没有的类型不带，每类最多记到 99 |
| `rooms`  | 房间数所在的区间：`0`、`1`、`2-5`、`6-20`、`21+`                                                                                                                           |

### `feature_first_used`：关键功能第一次用到

每台电脑每个功能只记一次。`feature` 取值：

| 值                | 什么时候记                |
| ----------------- | ------------------------- |
| `room_create`     | 第一次建房间              |
| `agent_join`      | 第一次有 Agent 接入       |
| `invite_member`   | 第一次生成访客邀请        |
| `im_connect`      | 第一次连上飞书、微信等 IM |
| `mcp_install`     | 第一次给 Agent 装 MCP     |
| `artifacts_panel` | 第一次打开产物面板        |
| `code_panel`      | 第一次打开代码面板        |

### `update_result`：更新的结果

| 字段      | 内容                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| `kind`    | 更新的是什么：`desktop`（桌面端应用内更新）、`npm`（`hive update`）、`agent_cli`（在设置里安装或升级 Agent CLI） |
| `outcome` | `success` 或 `failure`                                                                                           |
| `reason`  | 失败类别，只在失败时有，见下表                                                                                   |
| `target`  | 只在 `agent_cli` 时有：哪个 CLI，取值同 `heartbeat.agents` 的类型                                                |
| `action`  | 只在 `agent_cli` 时有：`install` 或 `upgrade`                                                                    |

失败类别（`reason`）：

| 更新方式    | 取值                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `desktop`   | `no_package`、`not_installed`、`translocated`、`read_only`、`not_writable`、`network`、`checksum`、`bad_package` |
| `npm`       | `install_failed`、`package_mismatch`、`verify_failed`、`busy_agents`、`restart_failed`、`not_managed`            |
| `agent_cli` | `timeout`、`stalled`、`exit_code`、`spawn_failed`、`version_unknown`、`version_unchanged`、`install_broken`      |
| 都可能      | `unknown`（归不进上面的类别）                                                                                    |

### `incident_counts`：故障按类别计数

随每天的 `heartbeat` 一起记，只有这段时间出过故障时才有。`counts` 按「来源\_位置」计次数，拍成 `counts_来源_位置`，每类最多记到 9999：

- 来源：`internal`（SuperHive 自己的问题）、`external`（模型、网络等外部原因）、`unknown`
- 位置：`invocation`（Agent 一轮失败）、`server`（Server 抛异常）、`protocol`（收到的事件没通过校验）、`web`（网页报错）

例如 `"counts_external_invocation": 2, "counts_internal_server": 1`。

## 我们承诺不收

- 消息、附件、提问、白板和任务的内容
- 文件路径、工作目录、仓库名和地址
- 房间名、房间 ID、人名、Agent 名、用户名
- 电脑名、IP 地址（Server 不记录也不转发。统计服务用的是项目自部署的 Umami：它不存 IP，只用 IP 粗算国家和地区；按 IP 算出的城市一小时内清掉）
- Token、key、密码等任何凭据
- 报错原文、日志、命令行参数

以上不是靠「小心不传」，而是只认白名单：每个字段只能取上面表格里的值，自由文本根本进不去。

## 上报和保留

- 只有 Hive Server 往外发；网页、桌面端和 `hive` 命令只把事件交给本机 Server 或写进本机队列。
- 每小时发一次，攒够 50 条提前发，一次最多 50 条。
- 网络不通、统计服务出错时，没发出去的留在本机，过一会儿再发：第一次隔 1 小时，连续失败每次翻倍，最多隔 1 天。统计服务明确拒收的直接丢掉。发送出错不影响任何功能。
- 本机最多留 200 条没发的，满了丢最旧的。
- 统计服务收到的数据保留 90 天，之后删除。
- npm 安装和桌面版默认发到 `https://60.205.92.58`（项目自部署的 Umami，发到它的 `/api/batch`）；源码运行默认不发。
- 想发到自己部署的 Umami，启动前设 `SUPERHIVE_TELEMETRY_URL=https://你的 Umami 地址`（只认 http 和 https，发到它的 `/api/batch`），再用 `SUPERHIVE_TELEMETRY_SITE` 填你那边站点的 websiteId。源码运行设了它也会发；设的不是 http(s) 地址时一条都不发，不会退回默认地址。
- 安装 ID、开关和待发的数据在 `~/.superhive/telemetry/`，可以用 `SUPERHIVE_TELEMETRY_DIR` 换个位置。
