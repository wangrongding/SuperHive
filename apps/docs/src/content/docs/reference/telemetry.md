---
title: 使用统计：收什么、不收什么、怎么关
description: SuperHive 默认记录匿名、粗粒度的使用统计。本页列出全部字段和事件、怎么查看和关闭、数据保留多久，以及我们承诺不收的数据。
---

SuperHive 默认开启匿名使用统计：只记版本、系统、用到了哪些功能、更新成没成功这类粗粒度的数，用来判断先修什么、先做什么。**不收消息、路径、名字和 key**，随时可以关。做法参照 Next.js 和 Homebrew：默认开、第一次告诉你、一个开关或一个环境变量就能关。

:::note[当前版本一条都不发]
统计服务还没上线，内置的上报地址是空的：数据只记在这台电脑上，可以随时预览，不会发出去。以后接上统计服务时会在更新说明里写明。
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

- 网页「设置 → 这台电脑 → 匿名使用统计」点「查看要发送的数据」，显示下一次要发的原始 JSON。
- 终端运行 `hive telemetry preview`，内容和网页一样。

一次上报的请求体长这样：

```json
{
  "schema": 1,
  "installId": "8d0f3c1e-2a4b-4c6d-8e9f-0a1b2c3d4e5f",
  "events": [
    {
      "event": "heartbeat",
      "time": "2026-11-28T04:00:00.000Z",
      "context": {
        "version": "0.4.9",
        "runMode": "npm",
        "os": "darwin",
        "arch": "arm64",
        "locale": "zh-CN"
      },
      "props": { "agents": { "claude": 2, "codex": 1 }, "rooms": "2-5" }
    }
  ]
}
```

## 公共字段

| 字段              | 内容                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------- |
| `schema`          | 数据格式版本，现在是 `1`                                                              |
| `installId`       | 第一次启动时随机生成的 ID，和电脑、账号无关；可在设置里或 `hive telemetry reset` 重置 |
| `time`            | 事件发生的时间，只精确到小时（UTC）                                                   |
| `context.version` | SuperHive 版本号，例如 `0.4.9`                                                        |
| `context.runMode` | 运行方式：`npm`（npm 全局安装）、`desktop`（桌面端）、`source`（源码）                |
| `context.os`      | 操作系统：`darwin`、`win32`、`linux`、`other`                                         |
| `context.arch`    | CPU 架构：`x64`、`arm64`、`other`                                                     |
| `context.locale`  | 界面语言：`zh-CN`、`en`、`other`                                                      |

## 事件

所有字段都只能取下面列出的值；不认得的字段、不在范围里的值在记录前就丢掉，整条事件缺了必填字段也丢掉。

### `heartbeat`：每天一次

| 字段     | 内容                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `agents` | 本机 Agent 按 CLI 类型分的个数，类型只有 `codex`、`claude`、`copilot`、`opencode`、`omp`、`openclaw`、`gemini`、`agy`；每类最多记到 99 |
| `rooms`  | 房间数所在的区间：`0`、`1`、`2-5`、`6-20`、`21+`                                                                                       |

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

随每天的 `heartbeat` 一起记，只有这段时间出过故障时才有。`counts` 是「来源.位置」到次数的对照，每类最多记到 9999：

- 来源：`internal`（SuperHive 自己的问题）、`external`（模型、网络等外部原因）、`unknown`
- 位置：`invocation`（Agent 一轮失败）、`server`（Server 抛异常）、`protocol`（收到的事件没通过校验）、`web`（网页报错）

例如 `{ "external.invocation": 2, "internal.server": 1 }`。

## 我们承诺不收

- 消息、附件、提问、白板和任务的内容
- 文件路径、工作目录、仓库名和地址
- 房间名、房间 ID、人名、Agent 名、用户名
- 电脑名、IP 地址（Server 不记录也不转发；统计服务收到请求时看得到 IP，但不保存）
- Token、key、密码等任何凭据
- 报错原文、日志、命令行参数

以上不是靠「小心不传」，而是只认白名单：每个字段只能取上面表格里的值，自由文本根本进不去。

## 上报和保留

- 只有 Hive Server 往外发；网页、桌面端和 `hive` 命令只把事件交给本机 Server 或写进本机队列。
- 每小时发一次，攒够 50 条提前发。发送失败就丢掉，不重试、不堆积，也不影响任何功能。
- 本机最多留 200 条没发的，满了丢最旧的。
- 统计服务收到的数据保留 90 天，之后删除。
- 上报地址默认为空。想发到自己的统计服务，启动前设 `SUPERHIVE_TELEMETRY_URL=https://你的地址`（只认 http 和 https）。
- 安装 ID、开关和待发的数据在 `~/.superhive/telemetry/`，可以用 `SUPERHIVE_TELEMETRY_DIR` 换个位置。
