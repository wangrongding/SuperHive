---
title: 插件开发
description: 写一个 SuperHive 插件：在右侧栏加面板、在输入框加 / 命令、给本机 Agent 加 MCP 工具；默认零权限，房主在本机批准后才生效。
---

插件是一个文件夹，根上放 `superhive-plugin.json` 清单。第一阶段能做三件事：

- **右侧栏面板**：一个网页，跑在无同源的沙箱 iframe 里，只能通过 `postMessage` 向 SuperHive 要数据；
- **斜杠命令**：输入框里输入 `/命令 参数`，交给插件的面板处理，结果只填进输入框，发不发由人决定；
- **MCP 工具**：给本机 Agent 用的 stdio MCP Server，房主逐个确认后才写进运行时配置。

Hive Server 不执行插件里的任何代码：面板代码在浏览器沙箱里跑，MCP 由 Agent 的运行时（Claude Code、Codex 等）按配置启动。

## 安装和批准

1. 把插件文件夹放进 Hive 的插件目录：默认是数据目录下的 `plugins/`（和 `hive.sqlite` 同级），文件夹名要和清单里的 `id` 一致。可以用环境变量 `HIVE_PLUGINS_DIR` 换位置，`HIVE_PLUGINS=0` 整个关掉。
2. 在 **Server 所在的电脑** 上打开网页，进入「设置 · 插件」，点「刷新」就能看到它，以及它申请的每一条权限的说明。
3. 点「批准」后，面板出现在右侧栏的「插件」标签页，/ 命令开始生效。
4. 插件带 MCP 时，在同一页逐个勾选要写进哪些运行时，点「确认写入」。

只有 Server 所在电脑上的房主能批准、撤销；房主的其他设备、访客、Agent 都不行。

**撤销** 立即生效：打开着的面板马上卸掉，已经发出的面板地址也取不到文件，/ 命令失效，它写进运行时的 MCP 一并删除。

**升级**：替换文件夹即可。新版本没有多申请权限时照常可用；多申请了，整个插件停用，在设置页里标出「新增」的权限，房主重新批准后才恢复。MCP 的命令或参数改了，也要重新确认。

## 示例：骰子

仓库里的 `examples/plugins/dice` 是一个完整示例：右侧栏面板掷骰子、`/roll 2d6` 命令、给 Agent 一个 `roll_dice` MCP 工具。把它复制到插件目录试试：

```bash
cp -r examples/plugins/dice ~/path/to/data/plugins/dice
```

## 清单

```json
{
  "id": "dice",
  "name": "骰子",
  "version": "0.1.0",
  "description": "在右侧面板掷骰子，结果填进输入框",
  "engines": { "superhive": ">=0.4.0" },
  "permissions": ["members:read", "composer:write"],
  "guests": false,
  "contributes": {
    "panels": [{ "id": "main", "title": "骰子", "entry": "panel.html" }],
    "commands": [{ "name": "roll", "description": "掷骰子，例如 /roll 2d6", "panel": "main" }],
    "mcpServers": [
      {
        "name": "dice",
        "command": "node",
        "args": ["./mcp.mjs"],
        "description": "给 Agent 一个 roll_dice 工具"
      }
    ]
  }
}
```

| 字段                     | 说明                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | 小写字母、数字、点、短横线，3～64 个字符，和文件夹名一致                                                                      |
| `version`                | `x.y.z`                                                                                                                       |
| `engines.superhive`      | 兼容的 SuperHive 版本范围，支持 `*`、`x.y.z`、`>=`、`<`、`^`、`~`，空格分隔表示同时满足；写不认识的范围会按不兼容处理，不加载 |
| `permissions`            | 申请的权限，见下表；不写就是零权限                                                                                            |
| `guests`                 | 访客（凭邀请进来的人）能不能看到面板和命令，默认 `false`                                                                      |
| `contributes.panels`     | 最多 4 个；`entry` 是插件文件夹里的 `.html` 相对路径                                                                          |
| `contributes.commands`   | 最多 16 个；`name` 不带斜杠，`panel` 指向处理它的面板                                                                         |
| `contributes.mcpServers` | 最多 4 个，只支持 stdio                                                                                                       |

清单写错时，设置页会显示「不能加载」和具体原因。

## 权限

| 权限             | 能做什么                                                   |
| ---------------- | ---------------------------------------------------------- |
| `room:read`      | 面板打开期间，读当前查看者在这个房间能看到的最近 50 条消息 |
| `members:read`   | 读房间成员：名字、是人还是 Agent、是否在线                 |
| `composer:write` | 往输入框里填文字；插件不能替人发消息                       |

不在表里的权限一律拒绝。插件调用没批准的方法会收到 `PERMISSION_DENIED`。

## 面板

面板是普通网页，但运行环境有这些限制：

- iframe 不给 `allow-same-origin`，面板是不透明源：读不到 SuperHive 的 localStorage、Cookie，也不能带着登录调用 Hive 的接口；
- 响应头带 CSP：`connect-src 'none'`，不能联网（fetch、WebSocket 都会被拦下）；脚本、样式、图片只能来自插件自己的文件夹；
- 面板只能用这些扩展名的文件：`.html`、`.js`、`.mjs`、`.css`、`.json`、`.svg`、`.png`、`.jpg`、`.webp`、`.woff2`。

和 SuperHive 通信只有 `postMessage` 一条路。示例里的 `sdk.js` 是最小的封装，可以直接复制：

```js
// 调用方法：返回 Promise
const members = await superhive.call("room.members");
await superhive.call("composer.insert", { text: "🎲 2d6: 3 + 5 = 8" });

// 收到 / 命令
superhive.on("command", ({ name, args }) => {
  /* 输入 /roll 2d6 时 name = "roll"，args = "2d6" */
});

// 主题、语言变化
superhive.on("context", ({ theme, locale }) => {
  document.documentElement.dataset.theme = theme;
});
```

| 方法              | 需要的权限       | 返回                                                                |
| ----------------- | ---------------- | ------------------------------------------------------------------- |
| `context.get`     | 无               | `{ roomId, locale, theme, viewer }`，`viewer` 是 `owner` 或 `guest` |
| `room.messages`   | `room:read`      | `[{ seq, sender, content, createdAt }]`，参数 `{ limit }`，最多 50  |
| `room.members`    | `members:read`   | `[{ name, type, online }]`                                          |
| `composer.insert` | `composer:write` | 参数 `{ text }`（1～4000 字），接在输入框已有内容后面               |

底层消息格式：插件发 `{ superhive: 1, kind: "request", id, method, params }`；SuperHive 回 `{ superhive: 1, kind: "result", id, result }` 或 `{ superhive: 1, kind: "error", id, code, message }`；事件是 `{ superhive: 1, kind: "event", event, data }`。错误码有 `PERMISSION_DENIED`、`UNKNOWN_METHOD`、`BAD_PARAMS`、`FAILED`。

## 斜杠命令

在输入框里输入 `/roll 2d6` 并发送时，如果当前房间有已批准的插件声明了 `roll`，这条内容不会发到房间里：SuperHive 打开右侧栏的「插件」标签页，切到对应面板，再把 `{ name: "roll", args: "2d6" }` 发给它。面板还没加载完时会等它加载完再送。

没有插件认领的 `/xxx` 照常当普通消息发出去。带附件的消息不当命令处理。

## MCP 工具

清单里的 `command` 和 `args` 按插件文件夹解析：

- 以 `./` 开头的是插件里的文件，写进配置时换成绝对路径，不能跳出插件文件夹；
- 别的（`node`、`python3`、`uvx` 等）当作 PATH 上的程序名原样写入；
- 不经过 shell，不支持管道、变量等 shell 语法；带路径但不以 `./` 开头的命令会被拒绝。

房主确认后，SuperHive 按「Agent 运行时」设置页同一套方式（备份、原子替换）把它写进所选运行时的全局 MCP 配置，名字是 `plugin-<id>-<name>`。Agent 从下一轮会话起就能用上。

MCP 会作为本机程序运行，权限和 Agent 一样大，所以每个 MCP 都要房主单独确认；撤销插件、或在设置页取消勾选时，对应的配置会被删掉。

## 安全边界

- 默认零权限，清单里写的只是申请；
- 面板拿不到登录凭据，不能联网，不能替人发消息；
- 访客默认看不到插件；清单写了 `guests: true` 的，访客也只能用房主批准过的那些权限；
- 批准记录存在插件目录的 `.grants.json`。删掉它等于一次性撤销全部，面板地址随即取不到文件；但网页上已经打开的面板要刷新才会消失，写进运行时的 MCP 也要到设置页移除或手动删。正常撤销请用设置页。

更多设计考虑见仓库里的 `docs/research/plugin-system.md`。
