/**
 * 发到飞书 / 微信里给人看的文字：每个 IM 连接按自己的语言（/lang 切换）渲染。
 * 只有界面文字走这里；用户和 Agent 写的正文、房间名、成员名原样转述，不翻译。
 * 占位符写成 {name}，中英两边的占位符必须一致（im-texts.test.ts 会检查）。
 */
import { fillTemplate, serverTextTemplate, type ServerTextEntry } from "@superhive/protocol";

export const IM_LOCALES = ["zh-CN", "en"] as const;
export type ImLocale = (typeof IM_LOCALES)[number];

export function imLocaleOf(value: string | undefined): ImLocale {
  return value === "en" ? "en" : "zh-CN";
}

/** 「en」「English」「英文」→ en，「zh」「中文」→ zh-CN；认不出返回 undefined */
export function parseImLocale(value: string): ImLocale | undefined {
  const normalized = value.trim().toLocaleLowerCase();
  if (["en", "en-us", "english", "英文", "英语"].includes(normalized)) return "en";
  if (["zh", "zh-cn", "cn", "chinese", "中文", "简体中文", "汉语"].includes(normalized)) {
    return "zh-CN";
  }
  return undefined;
}

export const imTexts = {
  "im.worktree.ready": {
    zh: "{count} 个任务目录已合入，可安全清理",
    en: "{count} merged task directories are ready for safe cleanup",
  },
  "im.worktree.completed": {
    zh: "已清理 {count} 个任务目录",
    en: "Cleaned up {count} task directories",
  },
  "im.worktree.safety": {
    zh: "仅清理已登记、已合入、无文件改动且没有任务占用的目录；逐项复核，不强删。",
    en: "Only registered, merged, unchanged and unoccupied checkouts are removed. Each is rechecked; no force deletion.",
  },
  "im.worktree.cleanAll": { zh: "清理这批任务目录", en: "Clean up this batch" },
  "im.worktree.open": { zh: "打开房间管理任务目录", en: "Open room to manage task directories" },
  "im.worktree.queued": {
    zh: "已提交清理请求，逐项复核后会另发结果。",
    en: "Cleanup requested. Results will follow after each checkout is rechecked.",
  },
  "im.worktree.unavailable": {
    zh: "这批清理不可用或无权操作，请在网页的任务目录面板（顶栏分支下拉 →「管理任务目录」）查看。",
    en: 'This cleanup batch is unavailable or not authorized. Check the task directories panel on the web (branch dropdown in the top bar → "Manage task directories").',
  },
  "im.worktree.command": {
    zh: "微信没有卡片按钮；确认清理这批目录请发送 /worktree clean {batch}",
    en: "WeChat has no card buttons. To confirm cleanup of this batch, send /worktree clean {batch}",
  },
  "im.worktree.removed": { zh: "目录已移除", en: "Checkout removed" },
  "im.worktree.retained": {
    zh: "保留，安全检查未通过",
    en: "Retained; safety checks did not pass",
  },
  "im.worktree.audit": {
    zh: "请求清理 {count} 个 worktree",
    en: "Requested cleanup of {count} worktrees",
  },
  "im.worktree.discardAudit": {
    zh: "丢弃并删除未合入的 worktree {branch}（{count} 个提交）",
    en: "Discarded the unmerged worktree {branch} ({count} commits)",
  },
  "im.worktree.repairAudit": {
    zh: "修复被换了分支的 worktree：{action}",
    en: "Fixed a worktree whose branch was switched: {action}",
  },
  "im.worktree.autoAudit": {
    zh: "修改 worktree 自动清理：{enabled}",
    en: "Changed automatic worktree cleanup: {enabled}",
  },
  /* ---------- 通用 ---------- */
  "im.sep.list": { zh: "、", en: ", " },
  "im.sep.clause": { zh: "；", en: "; " },
  "im.sep.label": { zh: "：", en: ": " },
  "im.nobody": { zh: "未指定", en: "nobody" },
  "im.status.online": { zh: "空闲", en: "Idle" },
  "im.status.busy": { zh: "忙碌", en: "Busy" },
  "im.status.offline": { zh: "离线", en: "Offline" },
  "im.file.image": { zh: "图片", en: "Image" },
  "im.file.file": { zh: "文件", en: "File" },
  "im.error.code": { zh: "错误 {code}", en: "Error {code}" },
  "im.action.failed": { zh: "操作失败：{error}", en: "Something went wrong: {error}" },
  "im.button.menu": { zh: "菜单", en: "Menu" },
  "im.button.switchAgent": { zh: "切换对象", en: "Switch agent" },
  "im.button.switchRoom": { zh: "切换房间", en: "Switch room" },
  "im.button.pickAgent": { zh: "选对话对象", en: "Pick agent" },
  "im.button.who": { zh: "谁在忙", en: "Who's busy" },
  "im.button.level": { zh: "推送档位", en: "Notifications" },
  "im.button.help": { zh: "使用说明", en: "Help" },
  "im.button.follow": { zh: "继续问它", en: "Ask it more" },
  "im.button.stop": { zh: "停止", en: "Stop" },
  "im.button.retry": { zh: "重试", en: "Retry" },
  "im.button.dismiss": { zh: "忽略", en: "Dismiss" },
  "im.button.approve": { zh: "批准", en: "Approve" },
  "im.button.continue": { zh: "继续", en: "Continue" },
  "im.button.allow": { zh: "允许", en: "Allow" },
  "im.button.deny": { zh: "拒绝", en: "Deny" },
  "im.button.submit": { zh: "提交", en: "Submit" },
  "im.button.otherLanguage": { zh: "Switch to English", en: "切换到中文" },
  "im.link.view": { zh: "网页查看", en: "View on web" },
  "im.link.viewAll": { zh: "在网页查看", en: "View on web" },
  "im.link.open": { zh: "打开网页", en: "Open web app" },
  "im.link.handle": { zh: "到网页处理 {ref}", en: "Handle {ref} on the web" },
  "im.card.otherAnswer": { zh: "其它答案（选填）", en: "Other answer (optional)" },
  "im.card.attachments": { zh: "**附件 {count} 个**", en: "**Attachments: {count}**" },
  "im.card.empty": { zh: "（无内容）", en: "(empty)" },

  /* ---------- 新连接的名字 ---------- */
  "im.feishu.appName": { zh: "SuperHive 助手", en: "SuperHive Assistant" },
  "im.feishu.appDesc": {
    zh: "把飞书消息转进 SuperHive 房间",
    en: "Brings your Feishu messages into SuperHive rooms",
  },
  "im.feishu.label": { zh: "飞书机器人", en: "Feishu bot" },
  "im.wechat.label": { zh: "个人微信", en: "Personal WeChat" },

  /* ---------- 用法 ---------- */
  "im.help.text": {
    zh: [
      "SuperHive 用法：",
      "· 直接发文字、图片或文件：以你的身份发进当前房间；要让 Agent 干活，在消息里 @ 它，如「@rd-claude 看下测试为什么挂了」",
      "· Agent 向你提问时，点卡片上的选项，或回复这条提问打字（选项字母也行，多选用逗号隔开，如 A,C）",
      "· /to 选对话对象：选好后直接打字就发给它；也可以 /to codex。临时找别人写 @简写，如 @codex",
      "· 回复某个 Agent 的卡片，就是接着跟它说",
      "· /room 切换默认房间：直接发的消息进这个房间（点卡片或回编号），/room 房间ID 直接切；其他房间的推送照样收得到",
      "· /who 看房间里的 Agent 谁在忙",
      "· /level 查看推送档位，/level mine|im|agents|all 切换",
      "· /scope 接收范围：/scope all 收所有房间（默认，其他房间的卡片标成橙色），/scope current 只收默认房间",
      "· /lang en 把机器人切成英文（/lang zh 切回中文）",
      "· /web 获取在手机或其他电脑上打开网页的登录链接",
      "· /status 查看连接状态",
      "· /cards on 在飞书后台开通卡片回调后打开卡片按钮（重新扫码会自动开通）",
      "· 机器人菜单：飞书开发者后台 → 机器人 → 自定义菜单，菜单项选「推送事件」，事件 key 填 to、room、who、level、help",
    ].join("\n"),
    en: [
      "Using SuperHive:",
      '· Send text, images or files and they go into the current room as you. To get an agent working, @ it in your message, e.g. "@rd-claude why is this test failing?"',
      "· When an agent asks you something, tap an option on the card, or reply to the question (option letters work too; separate several with commas, e.g. A,C)",
      "· /to picks who you're talking to, so you can just type after that. /to codex works too. To reach someone else once, use a short @, e.g. @codex",
      "· Reply to an agent's card to keep talking to it",
      "· /room switches your default room, where messages you send go (tap the card or reply with a number); /room <room ID> switches directly. You still hear from the other rooms",
      "· /who shows which agents are busy",
      "· /level shows your notification level; /level mine|im|agents|all changes it",
      "· /scope sets which rooms you hear from: /scope all for every room (default; cards from other rooms are orange), /scope current for your default room only",
      "· /lang zh switches the bot to Chinese (/lang en switches back)",
      "· /web gets a sign-in link for opening the web app on your phone or another computer",
      "· /status shows the connection status",
      "· /cards on turns on card buttons once card callbacks are enabled in the Feishu console (scanning the QR code again enables them for you)",
      '· Bot menu: Feishu developer console → Bot → Custom menu. Choose "Push event" and set the event key to to, room, who, level or help',
    ].join("\n"),
  },

  /* ---------- 推送档位 ---------- */
  "im.level.mine.name": { zh: "与我相关", en: "Relevant to me" },
  "im.level.im.name": { zh: "仅 IM 发起", en: "Started from IM" },
  "im.level.agents.name": { zh: "全部 Agent 消息", en: "All agent messages" },
  "im.level.all.name": { zh: "全部消息", en: "Everything" },
  "im.level.mine.desc": {
    zh: "给你的最终结果、提到你、问你的问题、需要你处理的异常",
    en: "Final results for you, mentions of you, questions for you, and problems that need you",
  },
  "im.level.im.desc": {
    zh: "只推从这里发起的任务结果和提到你的消息",
    en: "Only results of tasks started here, and messages that mention you",
  },
  "im.level.agents.desc": {
    zh: "另外把给人看的 Agent 发言每 3 分钟合并，不推 Agent 内部讨论",
    en: "Also a digest of human-facing agent messages every 3 minutes; no internal agent discussions",
  },
  "im.level.all.desc": {
    zh: "默认房间的普通消息每 3 分钟合并，其它房间默认只推与你相关的；不推定时触发、本人回显或 Agent 内部讨论",
    en: "Ordinary messages in the default room are bundled every 3 minutes; other rooms send relevant updates by default. No scheduled triggers, own-message echoes or internal agent discussions",
  },
  "im.level.default": { zh: "（默认）", en: " (default)" },
  "im.level.full": { zh: "{name}：{desc}", en: "{name}: {desc}" },

  /* ---------- 收到 IM 消息 ---------- */
  "im.inbound.notOwner": {
    zh: "这个机器人只转发房主本人的消息。",
    en: "This bot only relays messages from the room owner.",
  },
  "im.inbound.unsupportedFiles": {
    zh: "目前只支持文字、图片和文件。",
    en: "Only text, images and files are supported for now.",
  },
  "im.inbound.unsupportedText": {
    zh: "目前只支持文字消息。",
    en: "Only text messages are supported for now.",
  },
  "im.inbound.ownerMissing": {
    zh: "在房间「{room}」里找不到成员 {owner}，请先在网页上进入这个房间。",
    en: 'Can\'t find {owner} in "{room}". Open this room in the web app first.',
  },
  "im.inbound.postFailed": {
    zh: "没能发进房间：{error}",
    en: "Couldn't post to the room: {error}",
  },
  "im.inbound.filesFailed": {
    zh: "没能收下附件（{failures}）。如果提示没有权限，请在网页上重新扫码连接飞书。",
    en: "Couldn't receive the attachments ({failures}). If it mentions permissions, reconnect Feishu by scanning the QR code again in the web app.",
  },
  "im.inbound.someFilesFailed": {
    zh: "有附件没能收下：{failures}",
    en: "Some attachments couldn't be received: {failures}",
  },
  "im.inbound.fileFailure": { zh: "{name}：{error}", en: "{name}: {error}" },
  "im.inbound.posted": {
    zh: "已发到房间「{room}」。要让 Agent 处理，请在消息里 @ 它；回复 /help 查看用法。",
    en: 'Posted to "{room}". To get an agent on it, @ it in your message. Reply /help for more.',
  },

  /* ---------- 命令 ---------- */
  "im.command.unknown": { zh: "不认识的命令 {command}。", en: "Unknown command: {command}" },
  "im.command.status": {
    zh: "{label} 已连接到房间「{room}」，以 {owner} 的身份发言。",
    en: '{label} is connected to "{room}" and posts as {owner}.',
  },
  "im.room.current": { zh: "默认房间：{room}", en: "Default room: {room}" },
  "im.room.currentMark": { zh: "（当前）", en: " (current)" },
  "im.room.textHint": {
    zh: "回复编号切换，或 /room 房间ID",
    en: "Reply with a number to switch, or send /room <room ID>",
  },
  "im.room.notFound": { zh: "没有房间 {room}。", en: "There's no room called {room}." },
  "im.room.notMember": {
    zh: "你还不是房间「{room}」的成员，请先在网页上进入一次。",
    en: 'You\'re not a member of "{room}" yet. Open it once in the web app first.',
  },
  "im.room.switched": { zh: "已切换到房间「{room}」。", en: 'Switched to "{room}".' },
  "im.room.switchedTarget": { zh: "对话对象：{name}。", en: " Talking to {name}." },
  "im.room.switchedNoTarget": {
    zh: "还没选对话对象，发 /to 选一个。",
    en: " No agent picked yet. Send /to to pick one.",
  },
  "im.room.switchedShort": { zh: "已切换到 {room}", en: "Switched to {room}" },
  "im.to.cleared": {
    zh: "已取消指定对话对象。",
    en: "You're no longer talking to a specific agent.",
  },
  "im.to.clearedShort": { zh: "已取消指定", en: "Cleared" },
  "im.to.ambiguous": {
    zh: "对上了多个：{names}，请写得更具体些。",
    en: "That matches several agents: {names}. Try a longer name.",
  },
  "im.to.notFound": { zh: "房间里没有 {name}。", en: "There's no {name} in this room." },
  "im.to.set": {
    zh: "之后不带 @ 的消息都发给 {name}。",
    en: "Messages without an @ will now go to {name}.",
  },
  "im.to.setShort": { zh: "之后直接打字就发给 {name}", en: "Just type and it goes to {name}" },
  "im.to.current": { zh: "当前对话对象：{name}", en: "Talking to: {name}" },
  "im.to.none": { zh: "0. 不指定", en: "0. Nobody" },
  "im.to.textHint": {
    zh: "回复编号选择，或 /to 名字（可简写）",
    en: "Reply with a number, or send /to <name> (short names work)",
  },
  "im.web.privateOnly": {
    zh: "登录链接只发到私聊：请在和机器人的私聊里发 /web。",
    en: "Sign-in links are only sent in private chat. Send /web in your private chat with the bot.",
  },
  "im.web.noUrl": {
    zh: "这个服务没有配置网页地址。",
    en: "This server doesn't have a web address configured.",
  },
  "im.web.title": { zh: "在网页上打开 Hive", en: "Open Hive in your browser" },
  "im.web.body": {
    zh: "点下面的按钮，在这台设备上以房主身份进入，不用填令牌。",
    en: "Tap the button below to sign in on this device as the owner. No token needed.",
  },
  "im.web.note": {
    zh: "链接 24 小时内有效，过期后再发 /web 获取，只发给你本人；不要转发给别人。手机要和运行 Hive 的电脑在同一个网络里才能打开。",
    en: "The link works for 24 hours; send /web again for a new one. It's for you only, so don't forward it. Your phone needs to be on the same network as the computer running Hive.",
  },
  "im.web.button": { zh: "在网页打开", en: "Open in browser" },
  "im.web.text": {
    zh: "在网页上打开（24 小时内有效，不要转发）：{url}",
    en: "Open in your browser (works for 24 hours, don't forward): {url}",
  },
  "im.who.none": { zh: "这个房间里还没有 Agent。", en: "No agents in this room yet." },
  "im.who.header": { zh: "房间「{room}」里的 Agent：", en: 'Agents in "{room}":' },
  "im.level.current": { zh: "当前推送档位：{level}", en: "Notification level: {level}" },
  "im.level.hint": {
    zh: "切换：/level mine | im | agents | all",
    en: "Change it: /level mine | im | agents | all",
  },
  "im.level.invalid": {
    zh: "档位只能是 mine、im、agents 或 all。",
    en: "The level must be mine, im, agents or all.",
  },
  "im.level.switched": { zh: "已切换为：{level}", en: "Switched to {level}" },
  "im.cards.unsupported": { zh: "这个渠道不支持卡片。", en: "This channel doesn't support cards." },
  "im.cards.on": {
    zh: "已打开卡片按钮：之后的提问、提醒可以直接在卡片上点。需要飞书应用已开通卡片回调（card.action.trigger）和消息更新权限，否则点了没反应；重新扫码会自动开通。",
    en: "Card buttons are on, so you can answer questions and handle alerts right on the cards. The Feishu app needs card callbacks (card.action.trigger) and permission to update messages, or taps won't do anything. Scanning the QR code again sets this up for you.",
  },
  "im.cards.off": {
    zh: "已关闭卡片按钮，提问改回打字作答。",
    en: "Card buttons are off. Answer questions by typing.",
  },
  "im.lang.switched": { zh: "已切换为中文。", en: "Switched to English." },
  "im.lang.current": {
    zh: "当前语言：中文。发 /lang en 切换为英文。",
    en: "Language: English. Send /lang zh to switch to Chinese.",
  },
  "im.lang.invalid": {
    zh: "语言只能是 zh（中文）或 en（English）。",
    en: "The language must be en (English) or zh (中文).",
  },

  /* ---------- 进度卡片 ---------- */
  "im.task.title": { zh: "已派给 {agents}", en: "Sent to {agents}" },
  "im.task.tag.running": { zh: "进行中", en: "Running" },
  "im.task.tag.done": { zh: "已完成", en: "Done" },
  "im.task.tag.partial": { zh: "未全部完成", en: "Not all done" },
  "im.task.note.running": {
    zh: "这张卡片会随进度自动更新",
    en: "This card updates as the work progresses",
  },
  "im.task.note.finished": { zh: "结果已单独发来", en: "Results were sent separately" },
  "im.task.queuedDelivered": { zh: "已送达，排队中", en: "Delivered, waiting in queue" },
  "im.task.queued": { zh: "排队中", en: "Queued" },
  "im.task.running": { zh: "执行中", en: "Running" },
  "im.task.waiting": { zh: "在等你回答", en: "Waiting for your answer" },
  "im.task.replied": { zh: "已回复 #{seq}", en: "Replied in #{seq}" },
  "im.task.done": { zh: "已完成", en: "Done" },
  "im.task.failed": { zh: "失败", en: "Failed" },
  "im.task.timedOut": { zh: "结果未知", en: "Outcome unknown" },
  "im.task.cancelled": { zh: "已停止", en: "Stopped" },
  "im.task.blocked": { zh: "已暂停", en: "Paused" },
  "im.task.withDetail": { zh: "{status}：{detail}", en: "{status}: {detail}" },

  /* ---------- 简写对上多个 ---------- */
  "im.pick.prompt": {
    zh: "「{token}」对上了 {count} 个 Agent，发给谁？",
    en: {
      one: '"{token}" matches {count} agent. Who should get it?',
      other: '"{token}" matches {count} agents. Who should get it?',
    },
  },
  "im.pick.tag": { zh: "选一个", en: "Pick one" },
  "im.pick.note": { zh: "点一下就带着这条消息发出", en: "Tap a name to send your message" },
  "im.pick.textHint": { zh: "回复编号即可发出", en: "Reply with a number to send it" },
  "im.pick.alreadySent": { zh: "这条消息已经发出过了", en: "This message has already been sent" },
  "im.pick.notInRoom": { zh: "房间里没有 {name}", en: "There's no {name} in this room" },
  "im.pick.handled": { zh: "已处理", en: "Handled" },
  "im.pick.sentTo": { zh: "已发给 {name}", en: "Sent to {name}" },
  "im.pick.sent": { zh: "已发出", en: "Sent" },

  /* ---------- 选对象、换房间 ---------- */
  "im.agents.title": { zh: "选择对话对象", en: "Pick an agent" },
  "im.agents.current": { zh: "当前：{name}", en: "Current: {name}" },
  "im.agents.nobody": { zh: "不指定", en: "Nobody" },
  "im.agents.note": {
    zh: "选好后直接打字就发给它（每个房间各记一个，一直有效）；临时找别人可以写 @简写，如 @codex",
    en: "Once picked, just type and it goes to them (remembered for each room until you change it). To reach someone else once, use a short @, e.g. @codex",
  },
  "im.agents.summary": { zh: "{title}：当前 {name}", en: "{title}: currently {name}" },
  "im.rooms.title": { zh: "切换房间", en: "Switch room" },
  "im.rooms.current": { zh: "当前：{room}", en: "Current: {room}" },
  "im.rooms.count": { zh: "{count} 个房间", en: "Rooms: {count}" },
  "im.rooms.online": { zh: "{count} 人在线", en: "{count} online" },
  "im.rooms.running": { zh: "{count} 个进行中", en: "{count} running" },
  "im.rooms.waiting": { zh: "{count} 个等你回答", en: "{count} waiting for you" },
  "im.rooms.note": {
    zh: "点一下就切换；切过去会恢复你在那个房间选过的对话对象",
    en: "Tap to switch. The agent you picked in that room comes back with it",
  },
  "im.rooms.summary": { zh: "切换房间：当前 {room}", en: "Switch room: currently {room}" },

  /* ---------- 控制面板 ---------- */
  "im.menu.title": { zh: "控制面板", en: "Control panel" },
  "im.menu.target": {
    zh: "**对话对象**：{name}（直接打字就发给它）",
    en: "**Talking to**: {name} (just type to message them)",
  },
  "im.menu.noTarget": {
    zh: "**对话对象**：未指定，消息里写 @ 或先选一个",
    en: "**Talking to**: nobody. @ an agent in your message, or pick one",
  },
  "im.menu.level": { zh: "**推送档位**：{level}", en: "**Notifications**: {level}" },
  "im.menu.scope": { zh: "**接收范围**：{scope}", en: "**Rooms**: {scope}" },
  "im.menu.agents": { zh: "**Agent**：{count} 个，{state}", en: "**Agents**: {count}, {state}" },
  "im.menu.busy": { zh: "{count} 个忙碌", en: "{count} busy" },
  "im.menu.idle": { zh: "都空闲", en: "all idle" },
  "im.menu.tasks": { zh: "；进行中 {count} 个任务", en: "; running tasks: {count}" },
  "im.menu.waiting": { zh: "，{count} 个在等你回答", en: ", waiting for you: {count}" },
  "im.menu.commands": {
    zh: "命令：/to 选对象、/room 换房间、/who 谁在忙、/level 推送档位、/scope 接收范围、/lang 语言、/help 说明",
    en: "Commands: /to pick agent, /room switch room, /who who's busy, /level notifications, /scope rooms, /lang language, /help help",
  },
  "im.menu.summary": { zh: "控制面板：{room}", en: "Control panel: {room}" },
  "im.footer": { zh: "当前：{room} → {name}", en: "Now: {room} → {name}" },

  /* ---------- 使用说明卡片 ---------- */
  "im.helpCard.title": { zh: "SuperHive 使用说明", en: "SuperHive help" },
  "im.helpCard.subtitle": { zh: "当前：{room} → {name}", en: "Now: {room} → {name}" },
  "im.helpCard.noTarget": { zh: "未指定对话对象", en: "no agent picked" },
  "im.helpCard.tag.buttons": { zh: "卡片按钮已开", en: "Card buttons on" },
  "im.helpCard.tag.text": { zh: "文字模式", en: "Text mode" },
  "im.helpCard.send.title": { zh: "💬 发消息", en: "💬 Sending messages" },
  "im.helpCard.send.basic": {
    zh: "- 直接发文字、图片、文件，以你的身份进入当前房间",
    en: "- Text, images and files go into the current room as you",
  },
  "im.helpCard.send.target": {
    zh: "- 没写 @ 的消息会发给 **{name}**",
    en: "- Messages without an @ go to **{name}**",
  },
  "im.helpCard.send.noTarget": {
    zh: "- 先选一个**对话对象**，之后不用再写 @",
    en: "- Pick an **agent to talk to** first, then you can skip the @",
  },
  "im.helpCard.send.alias": {
    zh: "- 临时找别人：写简写，如 `@codex 看下`；对上多个会让你选",
    en: "- To reach someone else once, use a short name like `@codex take a look`; if it matches several, you'll be asked to pick",
  },
  "im.helpCard.send.reply": {
    zh: "- **引用回复**某个 Agent 的卡片，就是接着跟它说",
    en: "- **Reply** to an agent's card to keep talking to it",
  },
  "im.helpCard.answer.title": { zh: "🙋 回答 Agent 的提问", en: "🙋 Answering agents" },
  "im.helpCard.answer.buttons": {
    zh: "- 在提问卡片上直接点选项；多选勾选后点「提交」\n- 也可以引用回复提问卡片打字",
    en: "- Tap an option on the question card; for multiple choice, tick the boxes and tap Submit\n- Or reply to the question card in your own words",
  },
  "im.helpCard.answer.text": {
    zh: "- 引用回复提问，写选项字母（多选用逗号隔开，如 `A,C`）或直接写答案",
    en: "- Reply to the question with option letters (comma-separated for several, e.g. `A,C`) or your own answer",
  },
  "im.helpCard.commands.title": { zh: "⌨️ 命令", en: "⌨️ Commands" },
  "im.helpCard.commands.body": {
    zh: [
      "- 发「菜单」或 `/` 打开**控制面板**，常用操作都能点",
      "- `/to` 选对话对象，`/to codex` 直接指定，`/to off` 取消",
      "- `/room` 切换默认房间（直接发的消息进这里）",
      "- `/who` 谁在忙",
      "- `/level` 推送档位",
      "- `/scope all` 收所有房间，`/scope current` 只收默认房间",
      "- `/lang en` 切换为英文",
      "- `/web` 在手机或其他电脑上打开网页（自动登录）",
      "- `/status` 连接状态",
    ].join("\n"),
    en: [
      "- Send `menu` or `/` to open the **control panel**, where the common actions are one tap away",
      "- `/to` picks an agent, `/to codex` picks one directly, `/to off` clears it",
      "- `/room` switches your default room (where messages you send go)",
      "- `/who` shows who's busy",
      "- `/level` sets notifications",
      "- `/scope all` hears from every room, `/scope current` from your default room only",
      "- `/lang zh` switches to Chinese",
      "- `/web` opens the web app on your phone or another computer (signed in for you)",
      "- `/status` shows the connection status",
    ].join("\n"),
  },
  "im.helpCard.commands.cards": {
    zh: "- `/cards on` 在飞书后台开通卡片回调后打开按钮",
    en: "- `/cards on` turns on buttons once card callbacks are enabled in the Feishu console",
  },
  "im.helpCard.menu.title": { zh: "📌 机器人菜单（可选）", en: "📌 Bot menu (optional)" },
  "im.helpCard.menu.body": {
    zh: "飞书开发者后台 → 机器人 → 自定义菜单，菜单项选「推送事件」，事件 key 填 `menu`（控制面板）、`to`、`room`、`who`、`level`、`help`",
    en: 'Feishu developer console → Bot → Custom menu. Choose "Push event" and set the event key to `menu` (control panel), `to`, `room`, `who`, `level` or `help`',
  },
  "im.helpCard.note": {
    zh: "重新扫码连接飞书后，提问、提醒卡片上会出现可以点的按钮",
    en: "Reconnect Feishu by scanning the QR code again to get tappable buttons on question and alert cards",
  },

  /* ---------- 谁在忙、推送档位卡片 ---------- */
  "im.whoCard.title": { zh: "谁在忙", en: "Who's busy" },
  "im.whoCard.busy": { zh: "{count} 个忙碌", en: "{count} busy" },
  "im.whoCard.idle": { zh: "都空闲", en: "All idle" },
  "im.whoCard.target": { zh: " · 当前对话对象", en: " · talking to" },
  "im.whoCard.summary": { zh: "谁在忙：{count} 个忙碌", en: "Who's busy: {count} busy" },
  "im.levelCard.title": { zh: "推送档位", en: "Notifications" },
  "im.levelCard.current": { zh: "当前：{name}", en: "Current: {name}" },
  "im.levelCard.summary": { zh: "推送档位：{name}", en: "Notifications: {name}" },

  /* ---------- 卡片按钮的即时提示 ---------- */
  "im.toast.paused": { zh: "这个连接已暂停", en: "This connection is paused" },
  "im.toast.notOwner": { zh: "只有房主本人可以操作", en: "Only the room owner can do this" },
  "im.toast.ownerMissing": {
    zh: "在房间里找不到成员 {owner}",
    en: "Can't find {owner} in this room",
  },
  "im.toast.roomCard": { zh: "已发来房间卡片", en: "Sent you the room list" },
  "im.toast.whoCard": { zh: "已发来成员状态", en: "Sent you who's busy" },
  "im.toast.levelCard": { zh: "已发来推送档位", en: "Sent you the notification settings" },
  "im.toast.noLevel": { zh: "没有这个档位", en: "There's no such level" },
  "im.toast.levelSwitched": { zh: "已切换推送档位", en: "Notification level updated" },
  "im.toast.followElsewhere": {
    zh: "{agent} 不在当前房间「{room}」，先切换房间",
    en: '{agent} isn\'t in "{room}". Switch rooms first',
  },
  "im.toast.menuCard": { zh: "已发来控制面板", en: "Sent you the control panel" },
  "im.toast.helpCard": { zh: "已发来使用说明", en: "Sent you the help" },
  "im.toast.pickerCard": { zh: "已发来选择卡片", en: "Sent you the agent list" },
  "im.toast.allFinished": { zh: "已经都结束了", en: "Everything has already finished" },
  "im.toast.stopPartial": {
    zh: "{ok} 个已请求停止，{failed} 个停不了",
    en: {
      one: "Asked {ok} of them to stop; {failed} task couldn't be stopped",
      other: "Asked {ok} of them to stop; {failed} tasks couldn't be stopped",
    },
    plural: "failed",
  },
  "im.toast.stopped": {
    zh: "已请求停止 {count} 个任务",
    en: { one: "Asked {count} task to stop", other: "Asked {count} tasks to stop" },
  },
  "im.toast.noQuestion": { zh: "找不到这条提问", en: "Can't find this question" },
  "im.toast.answered": {
    zh: "这个问题已经回答过了",
    en: "This question has already been answered",
  },
  "im.toast.pickFirst": {
    zh: "请先选一个选项，或填写其它答案",
    en: "Pick an option or type another answer first",
  },
  "im.toast.submitted": { zh: "已提交", en: "Submitted" },
  "im.toast.noTask": { zh: "找不到这条任务", en: "Can't find this task" },
  "im.toast.taskHandled": { zh: "这条任务已经处理过了", en: "This task has already been handled" },
  "im.toast.languageSwitched": { zh: "已切换为中文", en: "Switched to English" },
  "im.toast.followSwitched": {
    zh: "已切到 {room}，之后直接打字就发给 {name}",
    en: "Switched to {room}. Just type and it goes to {name}",
  },

  /* ---------- 接收范围、其他房间 ---------- */
  "im.scope.all": {
    zh: "所有房间（其他房间的卡片标成橙色）",
    en: "All rooms (cards from other rooms are orange)",
  },
  "im.scope.current": { zh: "仅默认房间", en: "Default room only" },
  "im.scope.switched": { zh: "接收范围改为：{scope}", en: "Now hearing from: {scope}" },
  "im.scope.status": {
    zh: "接收范围：{scope}\n切换：/scope all（所有房间）| /scope current（仅默认房间）",
    en: "Hearing from: {scope}\nChange it: /scope all (every room) | /scope current (default room only)",
  },
  "im.scope.invalid": {
    zh: "接收范围只能是 all（所有房间）或 current（仅默认房间）。",
    en: "The scope must be all (every room) or current (default room only).",
  },
  "im.button.scopeAll": { zh: "收所有房间", en: "Hear from all rooms" },
  "im.button.scopeCurrent": { zh: "只收默认房间", en: "Default room only" },
  "im.button.gotoRoom": { zh: "切到 #{room} 继续", en: "Continue in #{room}" },
  "im.otherRoom.prefix": { zh: "[#{room}]", en: "[#{room}]" },
  "im.otherRoom.textHint": {
    zh: "发 /room {room} 切过去继续",
    en: "Send /room {room} to continue there",
  },

  /* ---------- 卡片处理后的结论 ---------- */
  "im.resolved.answered": { zh: "已回答", en: "Answered" },
  "im.resolved.closed": { zh: "已结束", en: "Closed" },
  "im.resolved.dismissed": { zh: "已忽略", en: "Dismissed" },
  "im.resolved.extended": {
    zh: "已追加 {turns} 轮",
    en: { one: "Added {turns} turn", other: "Added {turns} turns" },
    plural: "turns",
  },
  "im.resolved.approved": { zh: "已批准", en: "Approved" },
  "im.resolved.retried": { zh: "已重试", en: "Retried" },
  "im.resolved.restarted": { zh: "已重新开始", en: "Restarted" },
  "im.resolved.done": { zh: "已完成", en: "Done" },
  "im.resolved.stopped": { zh: "已停止", en: "Stopped" },
  "im.resolved.waiting": { zh: "在等你回答", en: "Waiting for your answer" },
  "im.resolved.changed": { zh: "状态已变化", en: "Status changed" },
  "im.resolved.allowed": { zh: "已允许", en: "Allowed" },
  "im.resolved.denied": { zh: "已拒绝", en: "Denied" },
  "im.byOwner.dismiss": { zh: "{owner} 在飞书上忽略了", en: "Dismissed by {owner} in Feishu" },
  "im.byOwner.continue": {
    zh: "{owner} 在飞书上追加了 {turns} 轮",
    en: {
      one: "{owner} added {turns} turn in Feishu",
      other: "{owner} added {turns} turns in Feishu",
    },
    plural: "turns",
  },
  "im.byOwner.approve": { zh: "{owner} 在飞书上批准了", en: "Approved by {owner} in Feishu" },
  "im.byOwner.retry": { zh: "{owner} 在飞书上重试了", en: "Retried by {owner} in Feishu" },
  "im.answer.other": { zh: "其它：{text}", en: "Other: {text}" },
  "im.answer.option": { zh: "{key}：{label}", en: "{key}: {label}" },
  "im.answer.note": { zh: "{by} 的回答：{text}", en: "{by} answered: {text}" },

  /* ---------- 批准其他设备管理这台电脑 ---------- */
  "im.host.title": { zh: "需要你批准", en: "Needs your approval" },
  "im.host.tag": { zh: "待批准", en: "Pending" },
  "im.host.note": {
    zh: "5 分钟内有效。不是你本人在操作就点「拒绝」，并在设置 → 已登录设备里全部退出。",
    en: "Expires in 5 minutes. If this isn't you, tap Deny, then sign out all devices in Settings → Signed-in devices.",
  },
  "im.host.summary": { zh: "需要你批准：{summary}", en: "Needs your approval: {summary}" },
  "im.host.unsupported": {
    zh: "这个服务不支持在这里批准",
    en: "Approvals can't be handled here",
  },
  "im.host.notApprover": {
    zh: "这个账号没有登记为可批准，请到 Hive Server 所在的电脑上处理",
    en: "This account isn't set up to approve. Handle it on the computer running Hive Server",
  },
  "im.host.expired": {
    zh: "这条申请已经处理过或已过期",
    en: "This request was already handled or has expired",
  },
  "im.host.request.manage": {
    zh: "设备「{device}」申请在 12 小时内管理 {host}（启动、停止本机 Agent，修改设置）。获批后它能启动的 Agent 和 MCP 可能在没有沙箱的情况下执行命令；只有用完全权限启动时会再逐次确认。",
    en: 'The device "{device}" wants to manage {host} for 12 hours (start and stop local agents, change settings). Once approved, the agents and MCP servers it starts may run commands without a sandbox; starting one with full access still asks you each time.',
  },
  "im.host.request.createFull": {
    zh: "用完全权限启动本机 Agent {name}（{provider}）",
    en: "Start local agent {name} with full access ({provider})",
  },
  "im.host.request.createFullIn": {
    zh: "用完全权限启动本机 Agent {name}（{provider}，目录 {cwd}）",
    en: "Start local agent {name} with full access ({provider}, folder {cwd})",
  },
  "im.host.request.start": {
    zh: "启动完全权限的本机 Agent {name}",
    en: "Start local agent {name}, which has full access",
  },
  "im.host.request.restart": {
    zh: "重启完全权限的本机 Agent {name}",
    en: "Restart local agent {name}, which has full access",
  },

  /* ---------- 房主设备操作的安全提醒 ---------- */
  "im.audit.notice": {
    zh: "已登录的设备「{device}」在 {host} 上{action}。如果不是你本人操作，请立即在设置 → 已登录设备里全部退出。",
    en: 'The signed-in device "{device}" {action} on {host}. If this wasn\'t you, sign out all devices in Settings → Signed-in devices right away.',
  },
  "im.audit.revokeOne": { zh: "退出了另一台已登录的设备", en: "signed out another device" },
  "im.audit.revokeOthers": {
    zh: "退出了其他 {count} 台已登录的设备",
    en: { one: "signed out {count} other device", other: "signed out {count} other devices" },
  },
  "im.audit.networkProxy": {
    zh: "修改了本机 Agent 的网络代理设置",
    en: "changed the network proxy setting for local agents",
  },
  "im.audit.keepAwake": {
    zh: "修改了熄屏后保持在线的设置",
    en: "changed the stay-online-when-asleep setting",
  },
  "im.audit.agentCreated": {
    zh: "启动了本机 Agent {name}（{provider}，{access}）",
    en: "started local agent {name} ({provider}, {access})",
  },
  "im.audit.agentStarted": { zh: "启动了本机 Agent {name}", en: "started local agent {name}" },
  "im.audit.agentRestarted": { zh: "重启了本机 Agent {name}", en: "restarted local agent {name}" },
  "im.audit.agentRestartQueued": {
    zh: "安排本机 Agent {name} 在手上的任务做完后重启",
    en: "scheduled local agent {name} to restart once its current tasks finish",
  },
  "im.audit.agentAutoUpdateOn": {
    zh: "打开了本机 Agent 自动更新（落后时在空闲后自动重启）",
    en: "turned on local agent auto-update (restart when idle after the code changes)",
  },
  "im.audit.agentAutoUpdateOff": {
    zh: "关闭了本机 Agent 自动更新",
    en: "turned off local agent auto-update",
  },
  "im.audit.agentStopped": { zh: "停止了本机 Agent {name}", en: "stopped local agent {name}" },
  "im.audit.agentDeleted": { zh: "删除了本机 Agent {name}", en: "deleted local agent {name}" },
  "im.audit.roomCleared": { zh: "清空了房间 {room}", en: "cleared the room {room}" },
  "im.audit.mcpChanged": {
    zh: "修改了本机 Agent {name} 加载的 MCP",
    en: "changed which MCP servers local agent {name} loads",
  },
  "im.audit.autoSteerOn": {
    zh: "打开了本机 Agent {name} 的自动引导",
    en: "turned on auto-steer for local agent {name}",
  },
  "im.audit.modelChanged": {
    zh: "把本机 Agent {name} 的模型改成了 {model}",
    en: "set the model of local agent {name} to {model}",
  },
  "im.audit.effortChanged": {
    zh: "把本机 Agent {name} 的思考强度改成了 {effort}",
    en: "set the reasoning effort of local agent {name} to {effort}",
  },
  "im.audit.effortDefault": {
    zh: "把本机 Agent {name} 的思考强度改回跟随 CLI 配置",
    en: "set local agent {name} back to its CLI's configured reasoning effort",
  },
  "im.audit.contextChanged": {
    zh: "把本机 Agent {name} 的上下文设置改成了：自动压缩 {window}，缓存 {ttl}",
    en: "set the context settings of local agent {name} to: auto-compact {window}, cache {ttl}",
  },
  "im.audit.accessChanged": {
    zh: "把本机 Agent {name} 的权限改成了{access}，工作目录 {cwd}",
    en: "set the access of local agent {name} to {access}, working directory {cwd}",
  },
  "im.audit.accessChangedReadOnly": {
    zh: "把本机 Agent {name} 的权限改成了{access}",
    en: "set the access of local agent {name} to {access}",
  },
  "im.access.read-only": { zh: "只读", en: "read-only" },
  "im.access.workspace": { zh: "工作区", en: "workspace" },
  "im.access.full": { zh: "完全访问", en: "full access" },
  "im.audit.modelDefault": {
    zh: "把本机 Agent {name} 的模型改回运行时默认",
    en: "set local agent {name} back to its runtime's default model",
  },
  "im.audit.autoSteerOff": {
    zh: "关闭了本机 Agent {name} 的自动引导",
    en: "turned off auto-steer for local agent {name}",
  },
  "im.audit.mcpMeasured": { zh: "测量了本机 MCP", en: "measured the local MCP servers" },
  "im.audit.logsViewed": { zh: "查看了本机 Agent 日志", en: "viewed local agent logs" },
  "im.audit.terminalOpened": {
    zh: "在终端里打开了本机 Agent {name} 的会话",
    en: "opened local agent {name}'s session in a terminal",
  },

  /* ---------- 状态提醒 ---------- */
  "im.notice.thisTask": { zh: "这条任务", en: "this task" },
  "im.notice.failed": {
    zh: "⚠️ 处理 {ref} 失败{detail}\n到网页查看或重试 {ref}",
    en: "⚠️ {ref} failed{detail}\nView or retry {ref} on the web",
  },
  "im.notice.timedOut": {
    zh: "⚠️ 处理 {ref} 结果未知（长时间没有进展，不代表失败）\n到网页查看 {ref}",
    en: "⚠️ Outcome of {ref} unknown (no progress for a long time, which doesn't mean it failed)\nCheck {ref} on the web",
  },
  "im.notice.guest": {
    zh: "🔒 {guest} 是访客，请 {agent} 处理 {ref}，等你批准\n到网页点「批准」",
    en: "🔒 Guest {guest} asked {agent} to handle {ref} and needs your approval\nTap Approve on the web",
  },
  "im.notice.paused": {
    zh: "⏸️ {ref} 已暂停：{reason}\n到网页点「继续」",
    en: "⏸️ {ref} is paused: {reason}\nTap Continue on the web",
  },
  "im.notice.turnLimit": { zh: "Agent 对话轮数到了上限", en: "the agents hit the turn limit" },
  "im.notice.detail": { zh: "：{detail}", en: ": {detail}" },
  "im.notice.reason": { zh: "**原因**：{detail}", en: "**Reason**: {detail}" },
  "im.notice.failedTitle": { zh: "{agent} 处理失败", en: "{agent} failed" },
  "im.notice.failedNote": {
    zh: "可以直接重试，或到网页看详情",
    en: "Retry here, or see the details on the web",
  },
  "im.notice.failedNoteText": {
    zh: "可以到网页查看详情，或重试 {ref}",
    en: "See the details on the web, or retry {ref}",
  },
  "im.notice.timedOutTitle": { zh: "{agent} 结果未知", en: "{agent}: outcome unknown" },
  "im.notice.timedOutNote": {
    zh: "长时间没有进展，不代表失败；到网页确认后再决定是否重试",
    en: "No progress for a long time, which doesn't mean it failed. Check on the web before retrying",
  },
  "im.notice.guestTitle": { zh: "访客的任务等你批准", en: "A guest's task needs your approval" },
  "im.notice.guestBody": {
    zh: "**{guest}**（访客）请 **{agent}** 处理：",
    en: "**{guest}** (guest) asked **{agent}** to handle:",
  },
  "im.notice.guestNote": { zh: "批准后才会派发", en: "It's only sent once you approve" },
  "im.notice.guestNoteText": {
    zh: "到网页点「批准」后才会派发",
    en: "Tap Approve on the web to send it",
  },
  "im.notice.pausedTitle": { zh: "{agent} 已暂停", en: "{agent} is paused" },
  "im.notice.pausedNote": {
    zh: "点「继续」再给 {turns} 轮",
    en: {
      one: "Tap Continue to allow {turns} more turn",
      other: "Tap Continue to allow {turns} more turns",
    },
    plural: "turns",
  },
  "im.notice.pausedNoteText": { zh: "到网页点「继续」", en: "Tap Continue on the web" },

  /* ---------- 房间消息 ---------- */
  "im.message.approval": {
    zh: "{sender} 申请权限，等你批准",
    en: "{sender} is asking for permission",
  },
  "im.message.question": { zh: "{sender} 有问题问你", en: "{sender} has a question for you" },
  "im.message.progress": { zh: "{sender} 的进度", en: "Progress from {sender}" },
  "im.message.human": { zh: "{sender} 的消息", en: "Message from {sender}" },
  "im.message.mention": { zh: "{sender} 提到了你", en: "{sender} mentioned you" },
  "im.message.reply": { zh: "{sender} 的回复", en: "Reply from {sender}" },
  "im.message.tag.multiple": { zh: "多选", en: "Multiple choice" },
  "im.message.tag.single": { zh: "单选", en: "Single choice" },
  "im.message.tag.open": { zh: "待回答", en: "Needs an answer" },
  "im.message.tag.progress": { zh: "进度", en: "Progress" },
  "im.message.summary": { zh: "{sender}：{text}", en: "{sender}: {text}" },
  "im.question.cards": {
    zh: "直接点选作答；也可以回复这张卡片打字",
    en: "Tap an option to answer, or reply to this card in your own words",
  },
  "im.question.multiple": {
    zh: "回复这张卡片作答：选项字母，多选用逗号隔开（如 A,C）；也可以直接回复文字",
    en: "Reply to this card with option letters, comma-separated for several (e.g. A,C), or in your own words",
  },
  "im.question.single": {
    zh: "回复这张卡片作答：选项字母（如 A）；也可以直接回复文字",
    en: "Reply to this card with an option letter (e.g. A), or in your own words",
  },
  "im.question.open": { zh: "回复这张卡片作答", en: "Reply to this card to answer" },
  "im.question.textMultiple": {
    zh: "（可多选）",
    en: "(Choose one or more)",
  },
  "im.question.textSingle": { zh: "（单选）", en: "(Choose one)" },
  "im.question.hintMultiple": {
    zh: "（回复选项字母作答，多选用逗号隔开，如 A,C；也可以直接回复文字）",
    en: "(Reply with option letters, comma-separated for several, e.g. A,C, or in your own words)",
  },
  "im.question.hintSingle": {
    zh: "（回复选项字母作答，如 A；也可以直接回复文字）",
    en: "(Reply with an option letter, e.g. A, or in your own words)",
  },
  "im.question.hintOpen": {
    zh: "（直接回复这条消息作答）",
    en: "(Reply to this message to answer)",
  },
  "im.message.truncated": {
    zh: "正文太长已截断，全文见网页 #{seq}",
    en: "Too long, so it was cut off. See #{seq} on the web for the full text",
  },
  "im.message.attachments": { zh: "📎 附件 {count} 个：", en: "📎 Attachments ({count}):" },
  "im.message.attachment": { zh: "· {name}（{size}）", en: "· {name} ({size})" },
  "im.message.attachmentsLink": { zh: "到网页查看 #{seq}", en: "View #{seq} on the web" },
  "im.message.clipped": {
    zh: "…（太长已截断，全文见网页{where}）",
    en: "… (too long, so it was cut off; full text on the web{where})",
  },
  "im.held.otherChannel": {
    zh: "个人微信「{label}」的推送暂停了：微信要你先给机器人发一条消息才能继续推。在微信里随便发一句，暂停期间的推送会合成一条补发过去。",
    en: 'Pushes to your personal WeChat "{label}" are paused: WeChat needs you to send the bot a message before it can push again. Send it anything and the missed pushes will arrive in one message.',
  },
  "im.held.caughtUp": {
    zh: "推送暂停期间有 {count} 条没送到，现在补上：",
    en: {
      one: "{count} push didn't get through while pushes were paused. Here it is:",
      other: "{count} pushes didn't get through while pushes were paused. Here they are:",
    },
  },
  "im.held.older": {
    zh: "（更早的 {count} 条放不下，到网页查看）",
    en: {
      one: "({count} earlier push doesn't fit here; see it on the web)",
      other: "({count} earlier pushes don't fit here; see them on the web)",
    },
  },
  "im.digest.title": {
    zh: "{count} 条新消息",
    en: { one: "{count} new message", other: "{count} new messages" },
  },
} as const satisfies Record<string, ServerTextEntry>;

export type ImTextKey = keyof typeof imTexts;
export type ImTextParams = Record<string, string | number>;

/** 单复数和服务端文案目录同一套规则（protocol 的 serverTextTemplate） */
export function imText(locale: ImLocale, key: ImTextKey, params: ImTextParams = {}): string {
  const entry: ServerTextEntry = imTexts[key];
  return fillTemplate(serverTextTemplate(entry, locale, params), (name) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

/** 还没定语言的一句话：推给哪个连接就按哪个连接的语言渲染；参数也可以是一句话 */
export type ImMessage = {
  key: ImTextKey;
  params?: Record<string, string | number | ImMessage>;
};

export function renderImMessage(locale: ImLocale, message: ImMessage | string): string {
  if (typeof message === "string") return message;
  const params: ImTextParams = {};
  for (const [name, value] of Object.entries(message.params ?? {})) {
    params[name] = typeof value === "object" ? renderImMessage(locale, value) : value;
  }
  return imText(locale, message.key, params);
}
