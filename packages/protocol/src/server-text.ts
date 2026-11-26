import { z } from "zod";
import { isEnglishSingular } from "./plural.js";

/**
 * 服务端发给人看的文字（错误提示、调用状态说明、代发的系统消息）的唯一来源。
 *
 * 服务端只发 `{ key, params }`，网页、IM 按各自的语言用 renderServerText 渲染；
 * 原有的中文字段（error / detail / content）照旧一起发，给旧客户端和 Agent 看。
 * 占位符写作 {name}；参数值也可以是另一段 ServerText（例如状态名、原因），渲染时按同一语言展开。
 * 用户原文（消息正文、问题、任务说明）只作为参数原样带上，不翻译。
 *
 * 英文用语见 docs/development.md 的「界面用语」：room、agent、owner、guest、task、turn、
 * topic、whiteboard、schedule、approval、steer、lead agent。按钮动词开头，句首大写（sentence case）。
 */
export type ServerLocale = "zh-CN" | "en";

/** 英文单复数：按参数的数量选（one=1 条，other=其余），中文不分 */
export type PluralTemplate = { one: string; other: string };
/**
 * 一条文案。en 可以按数量分单复数，默认看参数 count，plural 指定别的参数（如 turns）。
 * 别逐条写 if：数量相关的英文都写成 { one, other }。
 */
export type ServerTextEntry = { zh: string; en: string | PluralTemplate; plural?: string };
type Entry = ServerTextEntry;

export const serverTexts = {
  "todo.handoff": {
    zh: "请处理待办：{title}",
    en: "Please handle this to-do: {title}",
  },
  "error.todo.notFound": {
    zh: "这个房间里没有所选待办。",
    en: "The selected to-do was not found in this room.",
  },
  "error.todo.assignee": {
    zh: "负责人必须是这个房间的成员。",
    en: "The assignee must be a member of this room.",
  },
  "error.todo.limit": {
    zh: "房间待办已达上限，请先删除不再需要的事项。",
    en: "This room reached its to-do limit. Delete items you no longer need first.",
  },
  "error.todo.completed": {
    zh: "已完成的待办不能交给 Agent，请先重新打开。",
    en: "Reopen the completed to-do before handing it to an agent.",
  },
  "error.whiteboard.conflict": {
    zh: "白板事项已变化，请刷新后重新选择。",
    en: "The whiteboard items changed. Refresh and select them again.",
  },
  "error.whiteboard.protected": {
    zh: "仍有工作区占用的事项不能归档或删除。",
    en: "Items that still hold a worktree claim cannot be archived or deleted.",
  },
  "error.whiteboard.notFound": {
    zh: "这个房间里没有所选白板事项。",
    en: "The selected whiteboard item was not found in this room.",
  },
  "error.workspaceFiles.notConfigured": {
    zh: "这个房间还没有设工作区。",
    en: "This room has no workspace yet.",
  },
  "error.workspaceFiles.missing": {
    zh: "工作区目录不存在或无法访问。",
    en: "The workspace folder doesn't exist or can't be accessed.",
  },
  "error.workspaceFiles.guestsDisabled": {
    zh: "房主没有开放工作区文件查看。",
    en: "The owner hasn't allowed viewing workspace files.",
  },
  "error.workspaceFiles.sourceNotFound": {
    zh: "找不到这个工作区或 worktree，可能已被清理。",
    en: "That workspace or worktree wasn't found. It may have been cleaned up.",
  },
  "error.workspaceFiles.pathInvalid": {
    zh: "路径无效，只能查看工作区里的文件。",
    en: "Invalid path. Only files inside the workspace can be viewed.",
  },
  "error.workspaceFiles.pathOutside": {
    zh: "这个链接指向工作区外面，不能查看。",
    en: "This link points outside the workspace and can't be viewed.",
  },
  "error.workspaceFiles.notFound": {
    zh: "文件或目录不存在，可能刚被改动。",
    en: "The file or folder doesn't exist. It may have just changed.",
  },
  "error.workspaceFiles.notGit": {
    zh: "工作区不是 Git 仓库。",
    en: "The workspace isn't a Git repository.",
  },
  "error.workspaceFiles.refNotFound": {
    zh: "找不到这个提交或分支。",
    en: "That commit or branch wasn't found.",
  },
  "error.workspaceFiles.tooLarge": {
    zh: "内容太多，无法显示。",
    en: "Too much content to show.",
  },
  "error.workspaceFiles.timeout": {
    zh: "Git 响应超时，稍后再试。",
    en: "Git took too long. Try again later.",
  },
  "error.workspaceFiles.failed": {
    zh: "读取工作区失败：{reason}",
    en: "Couldn't read the workspace: {reason}",
  },
  "error.workspaceFiles.linkExpired": {
    zh: "预览链接已过期或无效，请重新打开文件。",
    en: "This preview link expired or is invalid. Open the file again.",
  },
  "error.workspaceFiles.revealRequired": {
    zh: "这个文件可能含有密钥，确认显示后才能查看。",
    en: "This file may contain secrets. Confirm before viewing it.",
  },
  "error.workspaceFiles.revealOwnerOnly": {
    zh: "只有房主可以查看疑似密钥文件的内容。",
    en: "Only the owner can view files that may contain secrets.",
  },
  "action.worktree": { zh: "管理工作区", en: "Manage worktrees" },
  "error.worktree.localOnly": {
    zh: "只有本机房主的可写 Agent 能管理工作区；访客、远端和只读 Agent 不行。",
    en: "Only a writable local owner agent can manage worktrees; guest, remote and read-only agents cannot.",
  },
  "error.worktree.repository": {
    zh: "房间工作区必须是本机非裸 Git 仓库：{reason}",
    en: "The room workspace must be a local, non-bare Git repository: {reason}",
  },
  "error.worktree.invalidRef": {
    zh: "分支或基线不合法：{ref}",
    en: "Invalid branch or base: {ref}",
  },
  "error.worktree.conflict": {
    zh: "工作区或分支已存在，不能接管：{path}",
    en: "The worktree or branch already exists and cannot be adopted: {path}",
  },
  "error.worktree.claim": {
    zh: "分支 {branch} 已由 {agent} 占用（{key}）。",
    en: "Branch {branch} is claimed by {agent} ({key}).",
  },
  "error.worktree.unregistered": {
    zh: "只能清理 Hive 登记的工作区：{path}",
    en: "Only Hive-registered worktrees can be removed: {path}",
  },
  "error.worktree.identity": {
    zh: "工作区路径、仓库或分支已改变，拒绝清理：{path}",
    en: "The worktree path, repository or branch changed; refusing removal: {path}",
  },
  "error.worktree.branchChanged": {
    zh: "任务目录 {path} 登记的分支是 {branch}，现在却在 {current}：不能在里面开工。房主可以在任务目录面板（顶栏分支下拉 →「管理任务目录」）里「切回登记分支」或「按当前分支重新登记」；要做新的工作请用 hive_worktree_create 以新 slug 另建任务目录，不要在已登记的任务目录里换分支。",
    en: 'Task workspace {path} is registered on {branch} but is now on {current}, so no work can start in it. The owner can "Switch back to the registered branch" or "Re-register on the current branch" in the task directories panel (branch dropdown in the top bar → "Manage task directories"); for new work create another task workspace with a new slug via hive_worktree_create instead of switching branches inside a registered one.',
  },
  "error.worktree.detached": {
    zh: "任务目录 {path} 处于 detached HEAD，不在登记的分支 {branch} 上：不能在里面开工，在里面切回 {branch} 后再试。",
    en: "Task workspace {path} is on a detached HEAD instead of its registered branch {branch}, so no work can start in it; switch it back to {branch} and retry.",
  },
  "error.worktree.missingDirectory": {
    zh: "任务目录 {path} 不在了或已不是目录，但登记的分支 {branch} 还在：不能在里面开工，也不会自动清理，请房主核对。",
    en: "Task workspace {path} is gone or no longer a directory, but its registered branch {branch} still exists. No work can start in it and it won't be cleaned up automatically; the owner needs to check it.",
  },
  "error.worktree.replaced": {
    zh: "任务目录 {path} 被换成了链接或别的路径，和登记的不是同一个目录：不能在里面开工。",
    en: "Task workspace {path} was replaced by a link or another path and is not the registered directory, so no work can start in it.",
  },
  "error.worktree.notCheckout": {
    zh: "任务目录 {path} 已不在仓库的 git worktree 列表里：不能在里面开工。",
    en: "Task workspace {path} is no longer listed by git worktree in the repository, so no work can start in it.",
  },
  "error.worktree.otherRepository": {
    zh: "任务目录 {path} 现在属于另一个 Git 仓库，和登记的不同：不能在里面开工。",
    en: "Task workspace {path} now belongs to a different Git repository than the registered one, so no work can start in it.",
  },
  "error.worktree.locked": {
    zh: "任务目录 {path} 被 git worktree lock 锁住了：解锁后再试。",
    en: "Task workspace {path} is locked with git worktree lock; unlock it and retry.",
  },
  "error.worktree.reuseSwitched": {
    zh: "slug {slug} 的任务目录 {path} 已被切到分支 {current}（登记的是 {branch}），不能复用。换一件事请用新的 slug 建新任务目录；要接着原任务线，请房主在任务目录面板（顶栏分支下拉 →「管理任务目录」）里「切回登记分支」或「按当前分支重新登记」。",
    en: 'The task workspace {path} for slug {slug} was switched to {current} (registered: {branch}) and cannot be reused. For a different task create a new task workspace with a new slug; to continue the original line, ask the owner to "Switch back to the registered branch" or "Re-register on the current branch" in the task directories panel (branch dropdown in the top bar → "Manage task directories").',
  },
  "error.worktree.notSwitched": {
    zh: "任务目录 {path} 没有被换分支，不需要处理。",
    en: "Task workspace {path} hasn't been switched to another branch; nothing to fix.",
  },
  "error.worktree.repairBusy": {
    zh: "任务目录 {path} 还有 {count} 个任务在用：等这些任务结束后再处理。",
    en: {
      one: "Task workspace {path} is still used by {count} task; wait until it finishes.",
      other: "Task workspace {path} is still used by {count} tasks; wait until they finish.",
    },
  },
  "error.worktree.restoreDirty": {
    zh: "任务目录 {path} 有未提交或未跟踪的文件，不能切回 {branch}：先提交或移走这些改动，或者改用「按当前分支重新登记」。",
    en: 'Task workspace {path} has uncommitted or untracked files, so it can\'t switch back to {branch}. Commit or move them first, or use "Re-register on the current branch" instead.',
  },
  "error.worktree.restoreBranchGone": {
    zh: "登记的分支 {branch} 已不存在或正被别的目录使用，不能切回；可以改用「按当前分支重新登记」。",
    en: 'The registered branch {branch} no longer exists or is checked out elsewhere, so it can\'t be restored; use "Re-register on the current branch" instead.',
  },
  "error.worktree.adoptTaken": {
    zh: "分支 {branch} 已被另一条任务线登记或占用，不能按它重新登记任务目录 {path}。",
    en: "Branch {branch} is already registered or claimed by another task line, so task workspace {path} can't be re-registered on it.",
  },
  "worktree.branchSwitched": {
    zh: "分支已被切换：登记 {registered}，当前 {current}（{path}）。房主可在任务目录面板（顶栏分支下拉 →「管理任务目录」）里切回登记分支或按当前分支重新登记；处理前不会沿用、也不会自动清理这个目录。",
    en: 'Branch switched: registered {registered}, now {current} ({path}). The owner can switch it back or re-register it on the current branch in the task directories panel (branch dropdown in the top bar → "Manage task directories"); until then it won\'t be reused or cleaned up automatically.',
  },
  "worktree.focusDropped": {
    zh: "{agent} 上次用的任务目录 {path} 不能再用（{reason}），这次的任务没有沿用它。",
    en: "{agent}'s last task workspace {path} can no longer be used ({reason}); this task did not reuse it.",
  },
  "worktree.focusCleaned": {
    zh: "已被清理；这次是新派的任务，不是那件活的续跑",
    en: "it was cleaned up; this is a newly assigned task, not a continuation of that one",
  },
  "error.worktree.unfinished": {
    zh: "任务目录 {path} 上次建立或清理没有完成：不能在里面开工。已合入且只缺了被删的文件时，后台扫描会自动接着清理；否则请房主在任务目录面板（顶栏分支下拉 →「管理任务目录」）里核对。",
    en: 'Task workspace {path} was left half-created or half-removed, so no work can start in it. If it is merged and only deleted files are missing, the background scan finishes the removal; otherwise the owner needs to check it in the task directories panel (branch dropdown in the top bar → "Manage task directories").',
  },
  "worktree.removalResumed": {
    zh: "上次没清理完的任务目录 {path} 已接着清理掉。",
    en: "Finished removing task workspace {path}, which a previous cleanup left half-removed.",
  },
  "worktree.removalResumeFailed": {
    zh: "上次没清理完的任务目录 {path} 这次还是没删掉（{reason}），下次扫描再试。",
    en: "Still couldn't finish removing the half-removed task workspace {path} ({reason}); will retry on the next scan.",
  },
  "error.worktree.unsafe": {
    zh: "工作区不能清理：有改动、未跟踪/忽略文件、尚未合入或仍有任务占用。{path}",
    en: "Cannot remove this worktree: changes, untracked/ignored files, unmerged work or active tasks remain. {path}",
  },
  "error.worktree.discardUnsafe": {
    zh: "不能丢弃这个任务目录：已合入的请用普通清理；有改动、未跟踪/忽略文件、任务占用，或分支在你确认后又有了新提交，都不删。{path}",
    en: "Cannot discard this worktree: use normal cleanup if it is merged; it is kept when it has changes, untracked/ignored files, active tasks, or new commits since you confirmed. {path}",
  },
  "worktree.discarded": {
    zh: "{by} 丢弃并删除了未合入的任务目录 {path}（分支 {branch}，丢弃 {count} 个提交）",
    en: "{by} discarded the unmerged worktree {path} (branch {branch}, {count} commits dropped)",
  },
  "error.sandbox.disabled": {
    zh: "沙箱预览模式下不能这样做：它会动到真实仓库、本机进程或外部服务。",
    en: "Not available in sandbox preview: it would touch real repositories, local processes or external services.",
  },
  "error.worktree.operation": {
    zh: "工作区操作失败，未强制删除：{reason}",
    en: "Worktree operation failed; nothing was forcibly deleted: {reason}",
  },
  "worktree.created": { zh: "工作区 {branch}：{path}", en: "Worktree {branch}: {path}" },
  "worktree.cleaned": {
    zh: "任务目录已被清理：{path}",
    en: "The task workspace was cleaned up: {path}",
  },
  "worktree.deps.preparing": {
    zh: "正在后台准备依赖（{command}）。装好前不要自己再跑安装；用 hive_worktree_list 看 dependencies 的结果。",
    en: "Preparing dependencies in the background ({command}). Do not start another install meanwhile; check dependencies in hive_worktree_list.",
  },
  "worktree.deps.installed": {
    zh: "依赖已装好（{command}，{seconds} 秒）。",
    en: "Dependencies installed ({command}, {seconds}s).",
  },
  "worktree.deps.linked": {
    zh: "{command} 没成功（{reason}），已退回软链主目录的依赖，workspace 内部包指向本任务线。改了 package.json 或锁文件要自己重新安装。",
    en: "{command} did not succeed ({reason}); dependencies are symlinked from the primary checkout, with workspace packages pointing at this worktree. Reinstall yourself after changing package.json or the lockfile.",
  },
  "worktree.deps.linkedNoInstall": {
    zh: "没有锁文件，没有安装；已软链主目录的依赖，workspace 内部包指向本任务线。",
    en: "No lockfile, so nothing was installed; dependencies are symlinked from the primary checkout, with workspace packages pointing at this worktree.",
  },
  "worktree.deps.failed": {
    zh: "依赖没准备好（{reason}），主目录也没有可软链的 node_modules。请在任务目录里自己安装。",
    en: "Dependencies were not prepared ({reason}) and the primary checkout has no node_modules to link. Install them yourself in the worktree.",
  },
  "worktree.deps.notNode": {
    zh: "不是 Node 项目，没有准备依赖。",
    en: "Not a Node project; no dependencies prepared.",
  },
  "worktree.deps.present": {
    zh: "目录里已有 node_modules，没有动。",
    en: "node_modules already exists; left untouched.",
  },
  "worktree.deps.interrupted": {
    zh: "Server 重启打断了依赖准备。请在任务目录里自己安装。",
    en: "A server restart interrupted dependency preparation. Install them yourself in the worktree.",
  },
  "worktree.deps.reason.timeout": { zh: "超时", en: "timed out" },
  "worktree.deps.reason.spawn": {
    zh: "命令没能运行，可能没装 {manager}",
    en: "the command could not start; {manager} may be missing",
  },
  "worktree.deps.reason.exit": { zh: "安装出错退出", en: "the install exited with an error" },
  "worktree.deps.reason.noLockfile": { zh: "没有锁文件", en: "no lockfile" },
  "worktree.deps.reason.error": { zh: "准备时出错", en: "an error occurred" },
  "worktree.missingReleased": {
    zh: "目录与分支均已不存在，已释放登记；不代表已验证合入：{path}",
    en: "The checkout and branch no longer exist; registration was released. This does not confirm a merge: {path}",
  },
  /* ---------- 调用（任务）状态说明 ---------- */
  "invocation.delivered": { zh: "已送达，排队中", en: "Delivered, waiting in queue" },
  "invocation.steerRequested": {
    zh: "{name} 请求引导",
    en: "{name} asked to add this to the current task",
  },
  "invocation.preemptRequested": {
    zh: "{name} 已请求停下当前任务，停下后先做这一条",
    en: "{name} asked to stop the current task and do this one first",
  },
  "invocation.steerSend": {
    zh: "请求引导",
    en: "Sent as steer: asked to add this to the current task",
  },
  "invocation.steerAuto": {
    zh: "自动请求引导",
    en: "Auto steer: asked to add this to the current task",
  },
  "invocation.answered": {
    zh: "{name} 已回答（#{seq}），已续到新的调用",
    en: "{name} answered (#{seq}); continued in a new task",
  },
  "invocation.waitingAnswer": {
    zh: "等人回答：{question}",
    en: "Waiting for your answer: {question}",
  },
  "invocation.stoppedNoAnswer": {
    zh: "{name} 不再回答，已停止",
    en: "Stopped: {name} won't answer",
  },
  "invocation.stoppedReason": { zh: "{reason}，已停止", en: "{reason}; stopped" },
  "invocation.stopRequested": {
    zh: "{name} 已请求停止，等待 {agent} 确认",
    en: "{name} asked to stop; waiting for {agent} to confirm",
  },
  "invocation.stopRequestedReason": {
    zh: "{reason}，{name} 已请求停止，等待 {agent} 确认",
    en: "{reason}; {name} asked to stop, waiting for {agent} to confirm",
  },
  "invocation.stopUnconfirmed": {
    zh: "停止请求超过 {minutes} 分钟没有得到确认，结果未知",
    en: "Stop wasn't confirmed within {minutes} min; outcome unknown",
  },
  "invocation.stale": {
    zh: "超过 {minutes} 分钟没有任何进展，结果未知",
    en: "No progress for over {minutes} min; outcome unknown",
  },
  "invocation.interruptedAgentStopped": {
    zh: "Agent 被停止，这一轮已中断；可能已执行过一部分，核对后可重试",
    en: "The agent was stopped, so this turn was interrupted. It may have done part of the work; check, then retry",
  },
  "invocation.interruptedAgentRestarted": {
    zh: "Agent 被重启，这一轮已中断；可能已执行过一部分，核对后可重试",
    en: "The agent was restarted, so this turn was interrupted. It may have done part of the work; check, then retry",
  },
  "invocation.interruptedAgentRemoved": {
    zh: "Agent 已被删除，这一轮已中断",
    en: "The agent was removed, so this turn was interrupted",
  },
  "invocation.interruptedServerStopped": {
    zh: "Hive Server 停止时结束了 Agent，这一轮已中断；可能已执行过一部分，核对后可重试",
    en: "Hive Server stopped and ended the agent, so this turn was interrupted. It may have done part of the work; check, then retry",
  },
  "invocation.redelivered": {
    zh: "Agent 在线但一直没确认收到，已重新派发一次",
    en: "The agent is online but never confirmed receipt; delivered once more",
  },
  "invocation.unacknowledged": {
    zh: "Agent 在线但没有确认收到（可能是不支持回报状态的旧版 superhive）",
    en: "The agent is online but never confirmed receipt (it may be an older superhive that can't report status)",
  },
  // 转交深度上限已取消（rd #6608），留着只为显示旧的拦截记录
  "invocation.blockedHop": {
    zh: "Agent 之间的转交已达 {limit} 跳上限，点「继续」或由人重新 @ 即可续上。",
    en: "Agents have handed this off {limit} times, the limit. Select Continue or @ an agent again to resume.",
  },
  "invocation.blockedTurns": {
    zh: "自上次有人发言以来 Agent 已连续对话 {used} 轮（上限 {limit}），等待人确认后继续。",
    en: "Agents have taken {used} turns in a row since anyone last spoke (limit {limit}). Waiting for someone to continue.",
  },
  "invocation.blockedPingPong": {
    zh: "{sender} 和 {agent} 没人插话地互相 @ 了 {count} 条，也没有附件或白板更新，像在来回绕圈，等人确认后继续。",
    en: "{sender} and {agent} have @-mentioned each other {count} times in a row with no one else joining and nothing produced (no attachments or board updates). This looks like a loop, so it's waiting for someone to continue.",
  },
  "invocation.blockedPair": {
    zh: "{sender} 今天已唤醒 {agent} {limit} 次，达到上限。",
    en: "{sender} has already woken {agent} {limit} times today, the daily limit.",
  },
  "invocation.blockedGuest": {
    zh: "{name} 是访客，@ 房主的 Agent 需要房主批准后才会派发。",
    en: "{name} is a guest. Tasks for the owner's agents start once the owner approves.",
  },
  "invocation.recalledNotRun": { zh: "消息已撤回，未执行", en: "Message unsent; not run" },

  /* ---------- 调用（任务）状态说明：续 ---------- */
  "invocation.receiptUndeliverable": {
    zh: "结果无法回执给 {name}：{reason}",
    en: "Couldn't send the result back to {name}: {reason}",
  },
  "invocation.replyWhileStopping": {
    zh: "停止期间收到回复，仍等待执行结束确认；回复中的 @ 未再派发",
    en: "A reply arrived while stopping; still waiting for the run to confirm it ended. @mentions in the reply weren't dispatched.",
  },
  "invocation.lateResult": { zh: "迟到的结果", en: "Late result" },
  "invocation.stopConfirmed": { zh: "{agent} 已确认停止", en: "{agent} confirmed it stopped" },
  "invocation.endedBeforeStop": {
    zh: "停止请求生效前已结束",
    en: "Finished before the stop took effect",
  },
  "invocation.recalledStopped": { zh: "消息已撤回，已停止", en: "Message unsent; stopped" },
  "invocation.recalledStopUnconfirmed": {
    zh: "消息已撤回，停止未确认：无法确认工具子进程都已停下：{reason}",
    en: "Message unsent; stop not confirmed. Couldn't confirm that all tool processes stopped: {reason}",
  },
  "invocation.stopUnconfirmedTools": {
    zh: "已停止 Agent 这一轮，但无法确认工具子进程都已停下：{reason}",
    en: "Stopped the agent's turn, but couldn't confirm that all tool processes stopped: {reason}",
  },
  "invocation.outcomeUnknown": { zh: "结果未知", en: "Outcome unknown" },
  "invocation.unknownNoReplay": {
    zh: "执行结果未知，无法确认工具已停止；禁止自动重放。",
    en: "Outcome unknown and tools may still be running, so it won't be retried automatically.",
  },
  "invocation.reasonRecalled": { zh: "消息已撤回", en: "Message unsent" },
  "invocation.approved": { zh: "{name} 已批准", en: "Approved by {name}" },
  "invocation.retryRequested": { zh: "{name} 请求重试", en: "{name} asked to retry" },
  "invocation.retryWithModel": {
    zh: "{name} 请求换成 {model} 重试",
    en: "{name} asked to retry with {model}",
  },
  "invocation.retryWithEffort": {
    zh: "{name} 请求用 {effort} 思考强度重试",
    en: "{name} asked to retry with {effort} reasoning effort",
  },
  "invocation.retryWithModelEffort": {
    zh: "{name} 请求换成 {model}（思考强度 {effort}）重试",
    en: "{name} asked to retry with {model} ({effort} reasoning effort)",
  },
  "error.guest.retryModel": {
    zh: "只有房主能换模型重试",
    en: "Only the room owner can retry with another model",
  },
  "invocation.turnsAdded": {
    plural: "turns",
    zh: "{name} 追加了 {turns} 轮（共 +{total}）",
    en: {
      one: "{name} added {turns} turn (+{total} total)",
      other: "{name} added {turns} turns (+{total} total)",
    },
  },
  "invocation.toolMessageSent": {
    zh: "已发出进行中的消息 #{seq}，仍在执行",
    en: "Sent an in-progress message (#{seq}); still running",
  },
  "invocation.supersededCompleted": {
    zh: "{agent} 之后的任务已正常完成",
    en: "A later task by {agent} completed normally",
  },
  "invocation.supersededTopic": {
    zh: "之后开启了新话题",
    en: "A new topic was started afterwards",
  },
  "error.schedule.alreadyFired": {
    zh: "已经到点发出了；要停止这次执行，请在任务面板里停止对应的调用。",
    en: "This has already run. To stop it, stop the matching task in Agent tasks.",
  },
  "error.schedule.ended": {
    zh: "这个定时任务已经结束，不能再取消。",
    en: "This scheduled task has already ended and can't be cancelled.",
  },
  "error.local.notThisComputer": {
    zh: "请求不是来自 Hive Server 所在的电脑",
    en: "This request didn't come from the computer running Hive Server",
  },
  "error.local.proxied": {
    zh: "经过代理转发的请求不能使用本机 Agent",
    en: "Requests through a proxy can't use local agents",
  },
  "error.local.host": {
    zh: "请用 localhost 或本机 IP 地址打开页面",
    en: "Open the page with localhost or this computer's IP address",
  },
  "error.local.crossSite": {
    zh: "跨站请求不能使用本机 Agent",
    en: "Cross-site requests can't use local agents",
  },
  "error.approval.feishuRequired": {
    zh: "这项操作需要你在飞书里确认一次。",
    en: "Confirm this once in Feishu.",
  },
  "error.approval.localRequired": {
    zh: "这项操作需要在 Hive Server 所在的电脑上确认一次。",
    en: "Confirm this once on the computer running Hive Server.",
  },
  "invocation.approvalWaiting": {
    zh: "等你批准：{summary}",
    en: "Waiting for your approval: {summary}",
  },

  /* ---------- 子任务回执 ---------- */
  "receipt.compact": {
    zh: "@{requester} 📬 子任务回执 · {status}\n委派：{task}\n[结果见 #{seq}](#message/{resultMessageId}/{seq})",
    en: "@{requester} 📬 Subtask receipt · {status}\nTask: {task}\n[Result: #{seq}](#message/{resultMessageId}/{seq})",
  },
  "receipt.delegation": {
    zh: "@{requester} 📬 子任务回执（Hive 代 {delegate} 发出）\n状态：{status}\n委派内容：{task}{outcome}\n子任务 ID：{id}",
    en: "@{requester} 📬 Subtask receipt (sent by Hive for {delegate})\nStatus: {status}\nTask: {task}{outcome}\nSubtask ID: {id}",
  },
  "receipt.result": { zh: "\n结果（#{seq}）：\n{result}", en: "\nResult (#{seq}):\n{result}" },
  "receipt.note": { zh: "\n说明：{note}", en: "\nNote: {note}" },
  "receipt.status.completed": { zh: "已完成", en: "Completed" },
  "receipt.status.failed": { zh: "失败", en: "Failed" },
  "receipt.status.cancelled": { zh: "已被停止", en: "Stopped" },
  "receipt.status.timedOut": {
    zh: "结果未知（超时没有进展，不代表失败）",
    en: "Outcome unknown (no progress before the timeout; not necessarily a failure)",
  },

  /* ---------- 定时任务：续 ---------- */
  "schedule.time": { zh: "{time}（{timeZone}）", en: "{time} ({timeZone})" },
  "schedule.trigger": {
    zh: "@{agent} ⏰ 定时任务（{agent} 于 #{originSeq} 设定，计划 {runAt}{recurrence}；Hive 代 {requester} 发出）\n以下是 {agent} 当初自己登记的备忘，不是 {requester} 新发的指令；只做原请求（#{originSeq}）范围内的事：\n{task}\n（服务端到点发出的消息：请现在执行并回复这条消息，结果里附上能证明完成的依据；需要人决定时用 hive_ask_human。{seriesHint}定时任务 ID：{id}）",
    en: "@{agent} ⏰ Scheduled task (set by {agent} in #{originSeq}, due {runAt}{recurrence}; sent by Hive for {requester})\nBelow is the note {agent} wrote when scheduling it. It isn't a new instruction from {requester}; stay within the original request (#{originSeq}):\n{task}\n(Sent by the server on schedule: do it now and reply to this message, with evidence that it's done. Use hive_ask_human if a person needs to decide. {seriesHint}Schedule ID: {id})",
  },
  "schedule.recurrence": {
    zh: "；每 {minutes} 分钟一次，第 {occurrence} 次，到 {until} 为止",
    en: "; every {minutes} min, run {occurrence}, until {until}",
  },
  "schedule.seriesHint": {
    zh: "下一次服务端会自己登记，不用你再建；目标已经达成、后面不用再检查时，用 hive_schedule_list 找到这个周期待执行的那一次，用 hive_schedule_cancel 取消，整个周期就结束了。",
    en: "The server schedules the next run itself, so don't create one. Once the goal is met and no more checks are needed, find this series' pending run with hive_schedule_list and cancel it with hive_schedule_cancel to end the series. ",
  },
  "schedule.report": {
    zh: "@{requester} ⏰ 定时任务没有正常完成（Hive 代 {agent} 发出）\n状态：{status}\n计划时间：{runAt}\n任务：{task}{note}\n定时任务 ID：{id}",
    en: "@{requester} ⏰ A scheduled task didn't finish normally (sent by Hive for {agent})\nStatus: {status}\nDue: {runAt}\nTask: {task}{note}\nSchedule ID: {id}",
  },
  "schedule.status.noReply": {
    zh: "执行结束但没有回复（Agent 回了 NO_REPLY 或没有输出）",
    en: "Finished without a reply (the agent returned NO_REPLY or nothing)",
  },
  "schedule.status.missed": { zh: "已错过", en: "Missed" },
  "schedule.status.failed": { zh: "没能发出", en: "Couldn't be sent" },
  "schedule.cancelledBy": { zh: "{name} 取消了", en: "Cancelled by {name}" },
  "schedule.skippedBusy": {
    zh: "上一次（第 {occurrence} 次）还没做完，跳过这一次",
    en: "Skipped: the previous run (run {occurrence}) is still going",
  },
  "schedule.missedOffline": {
    zh: "到点时 Server 没有运行，晚了 {minutes} 分钟才轮到，已标为错过、没有自动补跑",
    en: "The server wasn't running when this was due and got to it {minutes} min late, so it was marked missed and not run",
  },
  "schedule.missedInFlight": {
    zh: "发出途中 Server 停止，{minutes} 分钟后才恢复，已标为错过、没有自动补跑",
    en: "The server stopped while sending this and was back {minutes} min later, so it was marked missed and not run",
  },
  "schedule.memberGone": {
    zh: "发起人或执行的 Agent 已不在这个房间",
    en: "The requester or the agent is no longer in this room",
  },
  "schedule.requesterExpired": {
    zh: "发起人的访客权限已失效",
    en: "The requester's guest access has expired",
  },
  "schedule.triggerFailed": {
    zh: "触发消息发不出去：{reason}",
    en: "Couldn't send the trigger message: {reason}",
  },

  /* ---------- 提问与权限申请 ---------- */
  "question.ask": {
    zh: "{asker}❓ {question}{choices}\n（{hint}）",
    en: "{asker}❓ {question}{choices}\n({hint})",
  },
  "question.choices": { zh: "\n{mode}\n{options}", en: "\n{mode}\n{options}" },
  "question.single": { zh: "（单选）", en: "(Pick one)" },
  "question.multiple": { zh: "（可多选）", en: "(Pick one or more)" },
  "question.hintOptions": {
    zh: "点选选项、填写「其它」，或直接回复这条消息即可把答案交给 {agent}",
    en: "Pick an option, fill in Other, or reply to this message to send your answer to {agent}",
  },
  "question.hintReply": {
    zh: "回复这条消息即可把答案交给 {agent}",
    en: "Reply to this message to send your answer to {agent}",
  },
  "approval.request": {
    zh: "{asker}🔐 {agent} 申请权限（{tool}）：{summary}{detail}\nA. 允许\nB. 拒绝\n（点选，或回复这条消息「允许 / 拒绝」；{minutes} 分钟内没人批按拒绝处理）",
    en: "{asker}🔐 {agent} is requesting permission ({tool}): {summary}{detail}\nA. Allow\nB. Deny\n(Pick one, or reply Allow / Deny to this message. It's denied if no one decides within {minutes} min.)",
  },
  /* 网页气泡正文：选项已渲染成卡片，正文只留问题本身，见 questionBodyText */
  "question.body": { zh: "{asker}❓ {question}", en: "{asker}❓ {question}" },
  "approval.body": {
    zh: "{asker}🔐 {agent} 申请权限（{tool}）：{summary}{detail}\n（{minutes} 分钟内没人批按拒绝处理）",
    en: "{asker}🔐 {agent} is requesting permission ({tool}): {summary}{detail}\n(It's denied if no one decides within {minutes} min.)",
  },
  "approval.allow": { zh: "允许", en: "Allow" },
  "approval.deny": { zh: "拒绝", en: "Deny" },

  /* ---------- 话题与转发 ---------- */
  "topic.cleared": { zh: "{name} 清空了房间", en: "{name} cleared the room" },
  "topic.started": { zh: "{name} 开启了新话题", en: "{name} started a new topic" },
  "roomPost.forwarded": {
    zh: "{content}\n\n（{agent} 从 #{room} 的 #{seq} 转来，发起人 {requester}）",
    en: "{content}\n\n(Forwarded by {agent} from #{seq} in #{room}; requested by {requester})",
  },

  /* ---------- Bridge 上报的调用说明（中文模板与 superhive 的 bridge-text.ts 一致） ---------- */
  "bridge.crashedMidTurn": {
    zh: "Agent 在处理途中意外退出，结果未知；未自动重跑，需先核对原执行与工具进程。",
    en: "The agent exited unexpectedly mid-task, so the outcome is unknown. It wasn't rerun; check what the previous run and its tools did first.",
  },
  "bridge.beyondCatchUp": {
    zh: "Agent 首次加入时这条提及已超出补拉范围，未处理；可手动重试。",
    en: "This mention was older than what the agent fetches when it first joins, so it wasn't handled. Retry it manually.",
  },
  "bridge.reconnectedGone": {
    zh: "Agent 重新连接时这次处理已不在进行，结果未知；需先核对原执行与工具进程。",
    en: "When the agent reconnected, this run was no longer going, so the outcome is unknown. Check what the previous run and its tools did first.",
  },
  "bridge.cancelledBeforeRun": { zh: "任务在执行前被取消", en: "Cancelled before it started" },
  "bridge.notSteeredQueued": {
    zh: "当前没有正在执行、能引导的任务，已排队",
    en: "Nothing is running that this could join, so it's queued",
  },
  "bridge.steerUnsupported": {
    zh: "这个运行时不支持引导，已排队",
    en: "This runtime doesn't support steering, so it's queued",
  },
  "bridge.steering": { zh: "正在引导", en: "Adding to the current task" },
  "bridge.steerUnconfirmed": {
    zh: "消息已尝试注入但未获确认；禁止退回队列或自动重放。",
    en: "Tried to add the message but got no confirmation. It won't be requeued or retried automatically.",
  },
  "bridge.steerRemoved": {
    zh: "未注入的排队任务已移除",
    en: "Removed the queued task that wasn't added",
  },
  "bridge.steerCancelRace": {
    zh: "取消与注入并发，执行结果需核对",
    en: "Cancel and steer happened at the same time; check the outcome",
  },
  "bridge.steerEndRace": {
    zh: "消息注入与回合结束并发，结果待核实；禁止自动重放。",
    en: "Steer and the end of the turn happened at the same time; outcome unconfirmed. It won't be retried automatically.",
  },
  "bridge.steered": { zh: "已并入当前任务（#{seq}）", en: "Added to the current task (#{seq})" },
  "bridge.steerLate": {
    zh: "没能引导当前任务（这一轮已经收尾），已排队",
    en: "Couldn't join the current task (the turn was wrapping up), so it's queued",
  },
  "bridge.stoppedWhileWaiting": {
    zh: "等待自动继续时被停止",
    en: "Stopped while waiting to continue automatically",
  },
  "bridge.cancelNotPersisted": {
    zh: "无法持久化取消结果，需核对",
    en: "Couldn't save the cancellation; check the outcome",
  },
  "bridge.queuedRemoved": {
    zh: "尚未执行的排队任务已移除",
    en: "Removed the queued task before it ran",
  },
  "bridge.alreadyEnded": {
    zh: "这一轮在 Agent 这边早已结束，没有在跑的回合；当初的结果仍未知，请先核对再决定是否重试。",
    en: "This turn ended on the agent's side long ago and nothing is running. Its outcome is still unknown; check before deciding whether to retry.",
  },
  "bridge.stoppedNoReply": {
    zh: "本轮已结束，已停止的触发消息未发送回复",
    en: "The turn ended; no reply was sent for the stopped message",
  },
  "bridge.stopDeferred": {
    zh: "已请求停止，但同一轮还在处理其它没停的消息，这一轮会继续；这条不再回复，这一轮结束后标为已停止",
    en: "Stop requested, but this turn is still handling other messages that weren't stopped, so it keeps running; this one won't get a reply and will be marked stopped when the turn ends",
  },
  "bridge.noReply": { zh: "无需回复", en: "No reply needed" },
  "bridge.uncertain": {
    zh: "这一轮没做完就停了：{reason} 停下前可能已经执行过工具（改文件、跑命令等），所以没有自动重跑。点「继续」会接着原会话，先核对已做的再往下做；不需要了点「忽略」。",
    en: "This turn stopped before finishing: {reason} It may already have run tools (edited files, run commands), so it wasn't rerun automatically. Continue picks up the same session, checks what was done, then carries on; Dismiss if it's no longer needed.",
  },
  "bridge.offline": {
    zh: "Agent 已下线，本轮被中断；可在界面中重试",
    en: "The agent went offline and this turn was interrupted. You can retry it.",
  },
  "bridge.failedRepeatedly": {
    zh: "连续失败 {attempts} 次：{reason}",
    en: "Failed {attempts} times in a row: {reason}",
  },
  "bridge.upstreamFailed": {
    zh: "上游模型服务出错：{reason}。{why}；点「继续」会接着原会话从中断处往下做，不需要了点「忽略」。",
    en: "The model service had an error: {reason}. {why}. Continue picks up the same session where it stopped; Dismiss if it's no longer needed.",
  },
  "bridge.upstreamMutated": {
    zh: "这一轮已经做过改动，不自动重跑",
    en: "This turn already made changes, so it won't rerun automatically",
  },
  "bridge.crashResumed": {
    zh: "Agent 中途意外退出，这一轮还没做过任何改动，已自动重新执行（第 {count}/{limit} 次）",
    en: "The agent exited unexpectedly mid-task before changing anything, so it's running again automatically (attempt {count}/{limit})",
  },
  "bridge.crashResumedDone": {
    zh: "中途意外退出后已自动恢复 {count} 次",
    en: {
      one: "Resumed automatically {count} time after the agent exited unexpectedly",
      other: "Resumed automatically {count} times after the agent exited unexpectedly",
    },
  },
  "bridge.crashResumedNoReply": {
    zh: "无需回复（中途意外退出后已自动恢复 {count} 次）",
    en: {
      one: "No reply needed (resumed automatically {count} time after the agent exited unexpectedly)",
      other:
        "No reply needed (resumed automatically {count} times after the agent exited unexpectedly)",
    },
  },
  "bridge.crashedAfterResume": {
    zh: "Agent 在处理途中再次意外退出（已自动恢复过 {count} 次），结果未知；不再自动重跑，需先核对原执行与工具进程。",
    en: {
      one: "The agent exited unexpectedly mid-task again (already resumed automatically {count} time), so the outcome is unknown. It won't be rerun again; check what the previous run and its tools did first.",
      other:
        "The agent exited unexpectedly mid-task again (already resumed automatically {count} times), so the outcome is unknown. It won't be rerun again; check what the previous run and its tools did first.",
    },
  },
  "bridge.crashedIrreversible": {
    zh: "Agent 在处理途中意外退出，中断时正在执行：{step}；它做没做完不确定，确认后点「继续」，Agent 会先核对再往下做。",
    en: "The agent exited unexpectedly mid-task while running: {step}. It's unclear whether that finished; check, then click Continue and the agent will verify before carrying on.",
  },
  "bridge.crashedRuntimeAlive": {
    zh: "Agent 在处理途中意外退出，原运行时进程还没退出、可能仍在执行；未自动重跑，需先核对原执行与工具进程。",
    en: "The agent exited unexpectedly mid-task and its runtime process is still alive, so it may still be running. It wasn't rerun; check what the previous run and its tools did first.",
  },
  "bridge.crashResumeStopped": {
    zh: "Agent 中途意外退出后、自动恢复前已被停止，未重新执行",
    en: "Stopped after the agent exited unexpectedly, before it could resume; not run again",
  },
  "bridge.upstreamExhausted": {
    zh: "已自动继续 {count} 次仍未成功",
    en: {
      one: "Still failing after {count} automatic retry",
      other: "Still failing after {count} automatic retries",
    },
  },
  "bridge.fix.login": {
    zh: "凭证无效或没有登录，等多久都不会好，没有自动重试；先在这台电脑上重新登录这个 Agent 的 CLI 或检查 API key",
    en: "The credentials are invalid or the agent isn't signed in, which waiting won't fix, so it wasn't retried automatically. Sign in to this agent's CLI again on this computer or check the API key first",
  },
  "bridge.fix.quota": {
    zh: "用量额度用完了，到重置时间才会恢复，没有自动重试；等额度恢复或换个账号后再处理，也可以点「换个模型重试」",
    en: "The usage quota is used up and only comes back when it resets, so it wasn't retried automatically. Wait for the quota to reset or switch accounts, or use Retry with another model",
  },
  "bridge.fix.billing": {
    zh: "账户余额不足或欠费，没有自动重试；先充值或检查账单",
    en: "The account is out of credit or has a billing problem, so it wasn't retried automatically. Add credit or check billing first",
  },
  "bridge.fix.context": {
    zh: "对话超出了模型的上下文长度，没有自动重试；接着原会话多半还会超，建议开个新话题再派，或点「换个模型重试」换上下文更长的模型",
    en: "The conversation exceeds the model's context length, so it wasn't retried automatically. Continuing the same session will likely overflow again; start a new topic and assign it again, or use Retry with another model that has a longer context",
  },
  "bridge.fix.refused": {
    zh: "模型拒绝回答，原样重试结果一样，没有自动重试；可以换个说法重新派，或点「换个模型重试」",
    en: "The model declined to answer and would do the same again, so it wasn't retried automatically. Rephrase and assign it again, or use Retry with another model",
  },
  "bridge.fix.request": {
    zh: "模型服务拒绝了这次请求，原样重试结果一样，没有自动重试；多半是运行时或模型配置的问题，先检查配置",
    en: "The model service rejected the request and would do the same again, so it wasn't retried automatically. It's most likely a runtime or model configuration problem; check the configuration first",
  },
  "bridge.sessionRetrying": {
    zh: "会话已失效（{reason}），已开新会话重试",
    en: "The session stopped working ({reason}). Retrying in a new session",
  },
  "bridge.sessionInvalid": {
    zh: "会话已失效：{reason}。{why}；点「重试」会开新会话。",
    en: "The session stopped working: {reason}. {why}. Retry starts a new session.",
  },
  "bridge.sessionExecuted": {
    zh: "这一轮已经开始执行工具，不自动重跑",
    en: "This turn had already started running tools, so it wasn't rerun automatically",
  },
  "bridge.sessionRetried": {
    zh: "开了新会话还是失败",
    en: "It still failed in a new session",
  },
  "bridge.modelFailed": {
    zh: "模型用不了：{reason}。等多久都不会好，点「换个模型重试」选别的模型，或者在 Agent 设置里改模型。",
    en: "The model isn't available: {reason}. Waiting won't help. Use Retry with another model, or change the model in the agent's settings.",
  },
  "bridge.usingModel": {
    zh: "这次用 {model} 重试",
    en: "Retrying with {model}",
  },
  "bridge.usingEffort": {
    zh: "这次用 {effort} 思考强度重试",
    en: "Retrying with {effort} reasoning effort",
  },
  "bridge.usingModelEffort": {
    zh: "这次用 {model}（思考强度 {effort}）重试",
    en: "Retrying with {model} ({effort} reasoning effort)",
  },
  "bridge.effortUnsupported": {
    zh: "当前模型不支持 {effort} 思考强度（可选：{options}），这一轮按 CLI 配置的强度跑",
    en: "The current model doesn't support {effort} reasoning effort (available: {options}); this turn uses the CLI's configured effort",
  },
  "bridge.compacted": {
    zh: "上下文已自动压缩（{before} → {after} token）",
    en: "Context was auto-compacted ({before} → {after} tokens)",
  },
  "bridge.sessionRenewed": {
    zh: "房间主对话已约 {tokens} token，换了一段新对话，附上了交接摘要",
    en: "The room conversation had grown to about {tokens} tokens, so it started a fresh one with a handoff summary",
  },
  "bridge.worktreeHandoff": {
    zh: "已切到独立目录 {path}，开新会话继续；旧会话不迁移",
    en: "Continuing in a new session in isolated workspace {path}; the old session is not moved",
  },
  "bridge.worktreeFocusDropped": {
    zh: "上次用的任务目录 {path} 不能再用（{reason}），这次没有沿用，在默认工作目录开工；已提醒 Agent 改代码前先用 hive_worktree_create 建新任务目录",
    en: "The last task workspace {path} can no longer be used ({reason}); this task did not reuse it and starts in the default workspace. The agent was told to create a new task workspace with hive_worktree_create before changing code",
  },
  "bridge.worktreeCleaned": {
    zh: "任务目录已被清理，本轮无需继续执行：{path}",
    en: "The task workspace was cleaned up; no further execution is needed for this turn: {path}",
  },
  "bridge.worktreeBusy": {
    zh: "暂时没能确认这次该在哪个任务目录里干活（{reason}），已自动重试仍未成功；这一轮还没开始执行，稍后点「重试」即可",
    en: "Couldn't confirm which task workspace to use ({reason}) even after retrying automatically. Nothing has run yet, so just retry in a moment.",
  },
  "bridge.transientFailed": {
    zh: "暂时没成功：{reason}。已自动重试 {count} 次；这一轮还没开始执行，稍后点「重试」即可。",
    en: {
      one: "Temporarily failed: {reason}. Retried automatically {count} time. Nothing has run yet, so just retry in a moment.",
      other:
        "Temporarily failed: {reason}. Retried automatically {count} times. Nothing has run yet, so just retry in a moment.",
    },
  },
  "bridge.unsafe": {
    zh: "已停下，不会自动重试：{reason}。先按原因处理，再决定是否重试。",
    en: "Stopped and won't retry automatically: {reason}. Deal with the cause first, then decide whether to retry.",
  },
  "bridge.worktreeSteerQueued": {
    zh: "这条消息绑定了另一个工作目录 {path}，不能引导当前任务，已排队",
    en: "This message belongs to a different workspace, {path}. It cannot steer the current task and has been queued.",
  },
  "bridge.worktreeCheckBeforeContinue": {
    zh: "已绑定目录 {path}，但本轮已有其它副作用（{step}）；未自动续跑，请核对原目录的操作后再继续",
    en: "Workspace {path} is bound, but this turn had other side effects ({step}). It was not continued automatically; verify operations in the original checkout before continuing",
  },
  "error.worktree.runtimeRequired": {
    zh: "当前 Agent 尚未启用安全目录交接，请升级并重启本机 Agent 后再创建 worktree；不会扩大现有会话的写权限。",
    en: "This agent has not enabled safe workspace handoff. Upgrade and restart the local agent before creating a worktree; the existing session's write permissions are not expanded.",
  },
  "error.worktree.branchRetained": {
    zh: "目录已清理，但 Git 安全删除未通过，分支 {branch} 已保留；没有强制删除。",
    en: "The checkout was removed, but Git's safe branch deletion did not pass. Branch {branch} was retained; no force deletion was attempted.",
  },

  /* ---------- 操作名（嵌进错误提示里） ---------- */
  "action.createRoom": { zh: "新建房间", en: "create rooms" },
  "action.postToRoom": { zh: "到别的房间派活", en: "post tasks to other rooms" },

  /* ---------- 定时任务 ---------- */
  "schedule.roomCleared": { zh: "房间已清空", en: "The room was cleared" },

  /* ---------- 错误提示（HTTP 错误体与 WebSocket error 事件的 text） ---------- */
  "error.agent.askOutsideTask": {
    zh: "只能在处理某条消息的过程中向人提问。",
    en: "You can only ask a person a question while handling a message.",
  },
  "error.answer.duplicateOption": { zh: "选项重复。", en: "You picked the same option twice." },
  "error.answer.empty": {
    zh: "请至少选择一项，或填写「其它」。",
    en: "Pick at least one option, or fill in Other.",
  },
  "error.answer.singleChoice": {
    zh: "单选题只能选一项（或只填写「其它」）。",
    en: "This question takes one answer: pick one option, or fill in Other only.",
  },
  "error.answer.unknownOption": { zh: "没有选项 {option}。", en: "There's no option {option}." },
  "error.approval.forbidden": {
    zh: "只有房主（或带入这个 Agent 的访客）能批这个权限申请。",
    en: "Only the owner (or the guest who brought in this agent) can decide on this permission request.",
  },
  "error.approval.invalidAnswer": {
    zh: "权限申请只能选「允许」或「拒绝」。",
    en: "A permission request can only be answered with Allow or Deny.",
  },
  "error.approval.requestHandled": {
    zh: "这条申请已经处理过或已过期。",
    en: "This request was already handled or has expired.",
  },
  "error.approval.requestNotFound": {
    zh: "没有这条申请，或已经过期。",
    en: "This request doesn't exist or has expired.",
  },
  "error.attachment.expired": {
    zh: "附件上传后太久没有发出，已过期。",
    en: "This attachment was uploaded too long ago without being sent, so it expired.",
  },
  "error.attachment.expiredReupload": {
    zh: "附件上传后太久没有发出，已过期，请重新上传。",
    en: "This attachment was uploaded too long ago without being sent, so it expired. Upload it again.",
  },
  "error.attachment.failed": { zh: "附件处理失败。", en: "Couldn't process the attachment." },
  "error.attachment.fileRequired": { zh: "没有收到文件。", en: "No file was received." },
  "error.attachment.gone": {
    zh: "附件文件已被清理。",
    en: "The attachment file has been cleaned up.",
  },
  "error.attachment.previewUnsupported": {
    zh: "只有 HTML 附件能预览成网页。",
    en: "Only HTML attachments can be previewed as a page.",
  },
  "error.attachment.previewExpired": {
    zh: "预览链接已过期，请重新打开预览。",
    en: "This preview link has expired. Open the preview again.",
  },
  "error.attachment.localOnly": {
    zh: "只提供给本机的房主 Agent。",
    en: "Only available to the owner's agents on this computer.",
  },
  "error.attachment.messageRecalled": {
    zh: "附件所在的消息已撤回。",
    en: "The message with this attachment was unsent.",
  },
  "error.attachment.multipartRequired": {
    zh: "请用 multipart/form-data 上传文件。",
    en: "Upload files as multipart/form-data.",
  },
  "error.attachment.notFound": { zh: "附件不存在。", en: "Attachment not found." },
  "error.attachment.notInRoom": {
    zh: "这个房间里没有这个附件（可能已撤回）。",
    en: "There's no such attachment in this room (it may have been unsent).",
  },
  "error.attachment.openBlocked": {
    zh: "这类文件直接打开可能会运行程序，请改用「在文件夹中显示」，确认后自己打开。",
    en: "Opening this type of file directly could run a program. Show it in the folder instead and open it yourself if you trust it.",
  },
  "error.attachment.pendingNotFound": {
    zh: "没有这个待发附件。",
    en: "There's no such attachment waiting to be sent.",
  },
  "error.attachment.pendingQuota": {
    zh: "待发送的附件太多，请先发出或移除一些。",
    en: "Too many attachments are waiting to be sent. Send or remove some first.",
  },
  "error.attachment.rateLimited": {
    zh: "上传太频繁，请稍后再试。",
    en: "You're uploading too often. Try again in a moment.",
  },
  "error.attachment.roomQuota": {
    zh: "这个房间的附件空间已满，请撤回不需要的附件。",
    en: "This room's attachment storage is full. Unsend attachments you no longer need.",
  },
  "error.attachment.sentElsewhere": {
    zh: "附件已随另一条消息发出，请重新上传。",
    en: "This attachment was already sent with another message. Upload it again.",
  },
  "error.attachment.tooLarge": {
    zh: "单个附件不能超过 20 MiB。",
    en: "Each attachment can be at most 20 MiB.",
  },
  "error.attachment.tooMany": {
    zh: "一条消息最多带 10 个附件。",
    en: "A message can carry at most 10 attachments.",
  },
  "error.attachment.totalTooLarge": {
    zh: "一条消息的附件总量不能超过 50 MiB。",
    en: "A message's attachments can total at most 50 MiB.",
  },
  "error.attachment.unavailable": {
    zh: "附件不存在、已发出或不属于你，请重新上传。",
    en: "This attachment doesn't exist, was already sent, or isn't yours. Upload it again.",
  },
  "error.auth.agentsReportOnly": {
    zh: "只有 Agent 能回报任务进度。",
    en: "Only agents can report task progress.",
  },
  "error.auth.humansAnswer": {
    zh: "只有人能回答 Agent 的提问。",
    en: "Only people can answer an agent's questions.",
  },
  "error.auth.humansManageTasks": { zh: "只有人能管理任务。", en: "Only people can manage tasks." },
  "error.auth.notAllowed": { zh: "不允许。", en: "Not allowed." },
  "error.auth.ownerOnly": { zh: "只有房主可以执行这个操作。", en: "Only the owner can do this." },
  "error.auth.roomForbidden": {
    zh: "这个凭证不能访问该房间。",
    en: "These credentials can't access this room.",
  },
  "error.auth.unauthorized": {
    zh: "未授权，请重新登录或刷新页面。",
    en: "Not authorized. Sign in again or refresh the page.",
  },
  "error.delegation.agentNotFound": {
    zh: "房间里没有名为 {agent} 的 Agent。",
    en: "There's no agent named {agent} in this room.",
  },
  "error.delegation.cycle": {
    zh: "{agent} 正在等待这条委派链的结果，再委派给它会相互等待；请直接在回复里给出结论。",
    en: "{agent} is waiting on this delegation chain, so delegating back to it would deadlock. Give your conclusion in your reply instead.",
  },
  "error.delegation.noInvocation": {
    zh: "委派消息已发出，但没有为对方建立调用记录。",
    en: "The delegation message was sent, but no task was created for the other agent.",
  },
  "error.delegation.self": {
    zh: "不能把子任务委派给自己。",
    en: "You can't delegate a task to yourself.",
  },
  "error.device.localOnly": {
    zh: "这项操作只能在 Hive Server 所在的电脑上进行。",
    en: "This can only be done on the computer running Hive Server.",
  },
  "error.device.manageRequired": {
    zh: "这台设备还没有获准管理 Hive Server 所在的电脑，请先申请。",
    en: "This device isn't approved to manage the computer running Hive Server yet. Request access first.",
  },
  "error.device.notADevice": {
    zh: "只有房主登录的其他设备需要申请。",
    en: "Only other devices the owner signed in on need to request access.",
  },
  "error.device.notFound": {
    zh: "没有这台设备，或已经退出。",
    en: "This device doesn't exist or has already signed out.",
  },
  "error.device.ownerCredential": {
    zh: "缺少或错误的房主凭证，请刷新页面。",
    en: "The owner credential is missing or wrong. Refresh the page.",
  },
  "error.device.sessionInvalid": {
    zh: "这台设备的登录已失效，请重新扫码或在飞书里发 /web。",
    en: "This device's sign-in is no longer valid. Scan again, or send /web in Feishu.",
  },
  "error.device.signedOutByOwner": {
    zh: "这台设备已被房主退出登录。",
    en: "The owner signed this device out.",
  },
  "error.directory.absolute": {
    zh: "目录需要是绝对路径。",
    en: "The directory must be an absolute path.",
  },
  "error.directory.missing": { zh: "找不到目录 {path}。", en: "Directory {path} doesn't exist." },
  "error.directory.notDirectory": { zh: "{path} 不是目录。", en: "{path} isn't a directory." },
  "error.feature.disabled": { zh: "未启用。", en: "Not enabled." },
  "error.guest.agentGuestOnly": {
    zh: "只有访客本人可以为自己带入 Agent。",
    en: "Only the guest can bring in an agent for themselves.",
  },
  "error.guest.agentNotRenewable": {
    zh: "访客带入的 Agent 跟随访客的期限，请为访客续期。",
    en: "Agents brought in by a guest expire with the guest. Renew the guest instead.",
  },
  "error.guest.cancelScheduleOwn": {
    zh: "访客只能取消自己发起的定时任务。",
    en: "Guests can only cancel scheduled tasks they created.",
  },
  "error.guest.dismissOwn": {
    zh: "访客只能忽略自己发起的调用。",
    en: "Guests can only dismiss tasks they started.",
  },
  "error.guest.expired": {
    zh: "你的访问期限已到，请联系房主续期或重新邀请。",
    en: "Your access has expired. Ask the owner to extend it or invite you again.",
  },
  "error.guest.manageOwn": {
    zh: "访客只能重试或停止自己发起、且无需房主批准的调用。",
    en: "Guests can only retry or stop tasks they started that don't need the owner's approval.",
  },
  "error.guest.stopSharedTurn": {
    zh: "@{agent} 这一轮还在一起处理别人发起的消息，访客没法停下这一轮；需要的话请房主来停。",
    en: "@{agent} is handling messages other people started in this same turn, so guests can't stop it; ask the owner if it needs stopping.",
  },
  "error.guest.notFound": { zh: "找不到这个访客。", en: "Guest not found." },
  "error.guest.ownerActions": {
    zh: "访客不能开启新话题、追加轮数或删除白板事项。",
    en: "Guests can't start a new topic, add turns, or delete whiteboard items.",
  },
  "error.guest.preempt": {
    zh: "访客不能停下 Agent 正在执行的任务。",
    en: "Guests can't stop a task an agent is running.",
  },
  "error.guest.notPausable": {
    zh: "只能暂停访客带进来的 Agent；访客本人请用续期或移出房间。",
    en: "Only agents brought in by guests can be paused. Use renew or remove for the guest.",
  },
  "error.guest.paused": {
    zh: "房主暂停了这个 Agent，恢复后会自动重新连上。",
    en: "The owner paused this agent. It reconnects automatically once resumed.",
  },
  "error.guest.removed": {
    zh: "这个访客已被移除，请重新邀请。",
    en: "This guest was removed. Invite them again.",
  },
  "error.guest.revoked": {
    zh: "房主已把你移出这个房间。",
    en: "The owner removed you from this room.",
  },
  "error.im.connectionNotFound": { zh: "没有这个 IM 连接。", en: "There's no such IM connection." },
  "error.im.roomNotFound": {
    zh: "没有这个房间，或者已经归档。",
    en: "That room doesn't exist or has been archived.",
  },
  "error.im.notRoomMember": {
    zh: "你还不是这个房间的成员，请先在网页上进入一次。",
    en: "You're not a member of that room yet. Open it once in the web app first.",
  },
  "error.im.loginNotFound": {
    zh: "扫码会话不存在或已过期。",
    en: "This sign-in session doesn't exist or has expired.",
  },
  "error.im.ownerIdentity": {
    zh: "需要以房主本人在这个房间里的身份连接。",
    en: "Connect as the owner's own member in this room.",
  },
  "error.im.pairingCode": {
    zh: "配对码格式不对。",
    en: "The pairing code isn't in the right format.",
  },
  "error.im.wechatRisk": {
    zh: "连接个人微信前需要确认风险。",
    en: "Confirm the risks before connecting personal WeChat.",
  },
  "error.invite.expired": {
    zh: "这个邀请已经过期，请向房主要一个新邀请。",
    en: "This invite has expired. Ask the owner for a new one.",
  },
  "error.invite.identity": {
    zh: "这个邀请只能以 {name} 的身份进入 #{room}。",
    en: "This invite only lets you join #{room} as {name}.",
  },
  "error.invite.invalid": { zh: "邀请链接无效。", en: "This invite link isn't valid." },
  "error.invite.notFound": { zh: "邀请不存在。", en: "This invite doesn't exist." },
  "error.invite.revoked": { zh: "这个邀请已被房主撤销。", en: "The owner revoked this invite." },
  "error.invite.revokedReinvite": {
    zh: "这个邀请已被撤销，请重新邀请。",
    en: "This invite was revoked. Ask for a new one.",
  },
  "error.invocation.mayStillRun": {
    zh: "上一次执行可能还在进行。先停止，等 Agent 确认停下后再重试。",
    en: "The previous run may still be going. Stop it and wait for the agent to confirm before retrying.",
  },
  "error.invocation.notFound": { zh: "找不到这个任务。", en: "Task not found." },
  "error.invocation.notInRoom": {
    zh: "当前房间没有这个调用。",
    en: "There's no such task in this room.",
  },
  "error.invocation.notRetryable": {
    zh: "这个任务现在不能重试。",
    en: "This task can't be retried right now.",
  },
  "error.invocation.triggerGone": {
    zh: "触发这个任务的消息已经不在了。",
    en: "The message that started this task no longer exists.",
  },
  "error.invocation.messageRecalled": {
    zh: "消息已撤回，不能重试它派出的任务。",
    en: "This message was unsent. Its tasks can't be retried.",
  },
  "error.remoteJoin.notFound": {
    zh: "清单里没有这个 Agent，可能已经被删掉了。",
    en: "This agent isn't in the list anymore. It may have been removed.",
  },
  "error.remoteJoin.running": {
    zh: "{name} 已经在运行了。同一个名字再连一次会把它顶掉，要重新加入请先让它离线。",
    en: "{name} is already running. Joining again with the same name would kick it out, so take it offline first.",
  },
  "error.remoteJoin.failed": {
    zh: "没能把 Agent 带进去：{reason}",
    en: "Couldn't bring the agent in: {reason}",
  },
  "error.remoteJoin.restartFailed": {
    zh: "没能重新上线：{reason}",
    en: "Couldn't bring it back online: {reason}",
  },
  "error.remoteJoin.cwdRequired": {
    zh: "工作区读写和完全访问都要指定本机的工作目录。",
    en: "Workspace and full access both need a working folder on this computer.",
  },
  "error.remoteJoin.fullLocalOnly": {
    zh: "完全访问只能在这台电脑上设置。",
    en: "Full access can only be set on this computer.",
  },
  "error.guest.agentLeaveOnly": {
    zh: "只有访客带入的 Agent 能用自己的凭证退出房间。",
    en: "Only an agent brought in by a guest can leave the room with its own credentials.",
  },
  "error.networkProxy.disabled": {
    zh: "这个服务没有启用本机 Agent，不能设置网络代理。",
    en: "Local agents aren't enabled on this server, so there's no network proxy to set.",
  },
  "error.networkProxy.invalid": {
    zh: "代理地址格式不对：要写成 http://主机:端口 或 socks5://主机:端口，不能带路径。",
    en: "The proxy address isn't valid. Use http://host:port or socks5://host:port, without a path.",
  },
  "error.keepAwake.disabled": {
    zh: "这个服务没有启用熄屏后保持在线。",
    en: "Keep awake isn't enabled on this server.",
  },
  "error.runtimeCredentials.notEditable": {
    zh: "{field} 不能在网页上改：{reason}",
    en: "{field} can't be changed here: {reason}",
  },
  "error.runtimeCredentials.writeFailed": {
    zh: "写入 {file} 失败，原文件没有改动：{reason}",
    en: "Couldn't write {file}; the original file is unchanged: {reason}",
  },
  "error.runtimeCredentials.unreadable": {
    zh: "读不懂 {file}，没有改动：{reason}",
    en: "Couldn't parse {file}; nothing was changed: {reason}",
  },
  "runtimeCredentials.note.envKey": {
    zh: "密钥从环境变量 {name} 读取，请在启动 CLI 的环境里改",
    en: "The key is read from the {name} environment variable; change it where the CLI is launched",
  },
  "runtimeCredentials.note.chatgpt": {
    zh: "Codex 用 ChatGPT 账号登录，没有 API key",
    en: "Codex is signed in with a ChatGPT account and has no API key",
  },
  "runtimeCredentials.note.builtin": {
    zh: "Codex 用内置 OpenAI 服务；要换地址，先在 config.toml 里配一个 model_provider",
    en: "Codex uses the built-in OpenAI provider; add a model_provider in config.toml to change the URL",
  },
  "runtimeCredentials.note.complex": {
    zh: "config.toml 里这一项的写法认不出来，请手动修改",
    en: "This entry in config.toml uses a form SuperHive can't edit safely; change it by hand",
  },
  "runtimeCredentials.note.missing": {
    zh: "没有找到配置文件 {file}",
    en: "Config file {file} not found",
  },
  "runtimeCredentials.note.builtinProvider": {
    zh: "当前模型 {model} 用的是内置 provider，地址和登录由 CLI 自己管，配置文件里没有可改的项",
    en: "The current model {model} uses a built-in provider; its URL and sign-in are managed by the CLI, so there is nothing to change in the config file",
  },
  "runtimeCredentials.note.noModel": {
    zh: "配置里没有选当前模型，不知道该改哪个 provider",
    en: "No current model is selected in the config, so it's unclear which provider to change",
  },
  "runtimeCredentials.note.copilotOfficial": {
    zh: "Copilot 用 GitHub 账号登录（官方模型），没有地址和 key 可改",
    en: "Copilot is signed in with GitHub (official models); there's no URL or key to change",
  },
  "runtimeCredentials.note.envReference": {
    zh: "这一项引用环境变量 {name}，请在启动 CLI 的环境里改",
    en: "This entry references the {name} environment variable; change it where the CLI is launched",
  },
  "runtimeCredentials.note.shellCommand": {
    zh: "密钥由一条 shell 命令生成，不在网页上改",
    en: "The key is produced by a shell command and can't be changed here",
  },
  "runtimeCredentials.note.yamlUnsafe": {
    zh: "models.yml 用了锚点、别名、标签或 flow 写法，为免改坏不在网页上改，请手动修改",
    en: "models.yml uses anchors, aliases, tags or flow style; change it by hand so nothing breaks",
  },
  "runtimeCredentials.note.json5": {
    zh: "{file} 用了 JSON5 写法（如不带引号的键），为免改坏不在网页上改，请手动修改",
    en: "{file} uses JSON5 syntax (such as unquoted keys); change it by hand so nothing breaks",
  },
  "error.runtimeConfig.invalid": {
    zh: "配置值不合法：{reason}",
    en: "Invalid config value: {reason}",
  },
  "error.runtimeConfig.changed": {
    zh: "{file} 在你打开之后被改过了，为免覆盖没有保存；请重新打开再改。",
    en: "{file} changed after you opened it, so nothing was saved to avoid overwriting it. Reopen it and try again.",
  },
  "runtimeConfig.note.terminalOnly": {
    zh: "Hive 里的 Agent 按接入时选的权限档位自己设置这一项，这里只影响终端里直接运行的 CLI",
    en: "Hive agents set this from the access level chosen when they joined; this only affects the CLI run directly in a terminal",
  },
  "runtimeConfig.note.mcpUnsupported": {
    zh: "{name} 还不支持在配置文件里管理 MCP",
    en: "{name} doesn't support managing MCP servers in its config file yet",
  },
  "runtimeConfig.note.noToggle": {
    zh: "这个 CLI 的全局配置没有单独停用的开关，不用了就删掉",
    en: "This CLI's global config has no switch to disable a single server; delete it instead",
  },
  "runtimeSkills.note.plugin": {
    zh: "跟着插件 {plugin} 一起启停，请在 Claude Code 里用 /plugin 管理",
    en: "Turns on and off with the {plugin} plugin; manage it with /plugin in Claude Code",
  },
  "runtimeSkills.note.superhive": {
    zh: "Hive 自带的 superhive skill，Agent 靠它加入房间，只能查看；用 hive skill install / uninstall 管理",
    en: "The superhive skill ships with Hive and agents use it to join rooms, so it's read-only here; manage it with hive skill install / uninstall",
  },
  "runtimeSkills.note.system": {
    zh: "{name} 自带的系统 skill，可以停用，不能删除",
    en: "A system skill that ships with {name}; you can turn it off but not delete it",
  },
  "runtimeSkills.note.ompOwned": {
    zh: "omp 自己管理 config.yml（带锁文件），要停用请在终端运行 omp config set skills.ignoredSkills，或在 omp 里用 /settings",
    en: "omp manages config.yml itself (with a lock file); to turn a skill off, run omp config set skills.ignoredSkills in a terminal or use /settings inside omp",
  },
  "runtimeSkills.note.unreadable": {
    zh: "{file} 的写法认不出，为免改坏不在网页上启停，请手动修改",
    en: "{file} uses a layout Hive can't read safely; change it by hand so nothing breaks",
  },
  "runtimeSkills.note.unverified": {
    zh: "按 {name} 的文档实现，还没在真机上核对过",
    en: "Implemented from the {name} docs and not yet checked on a real install",
  },
  "error.runtimeSkills.notFound": {
    zh: "找不到这个 skill，可能已在别处被删掉，请刷新后再试。",
    en: "This skill wasn't found. It may have been deleted elsewhere; refresh and try again.",
  },
  "error.runtimeSkills.exists": {
    zh: "{target} 里已经有 {name}，没有覆盖。",
    en: "{target} already has {name}, so nothing was overwritten.",
  },
  "error.runtimeSkills.mcpNotPortable": {
    zh: "{name} 里的 {fields} 没法原样转成 {target} 的写法，没有复制。带请求头引用环境变量、令牌或 cwd、超时等专属字段的 MCP，请在 {target} 里手动添加。",
    en: "{fields} in {name} can't be carried over to {target} as is, so nothing was copied. Add MCP servers that use env-referencing headers, tokens or CLI-specific fields such as cwd or timeouts in {target} by hand.",
  },
  "error.runtimeSkills.moveFailed": {
    zh: "没能处理 {path}：{reason}",
    en: "Couldn't process {path}: {reason}",
  },
  "runtimeConfig.note.ompOwned": {
    zh: "omp 自己管理 config.yml（带锁文件），请在 omp 里用 /model 切换",
    en: "omp manages config.yml itself (with a lock file); switch models with /model inside omp",
  },
  "error.localAgent.configChanged": {
    zh: "Agent 的配置在批准后变了，已停下没有启动，请重新申请批准。",
    en: "The agent's configuration changed after approval, so it was stopped instead of started. Request approval again.",
  },
  "error.localAgent.cwdAbsolute": {
    zh: "工作目录需要是绝对路径，例如 /Users/me/project。",
    en: "The working directory must be an absolute path, such as /Users/me/project.",
  },
  "error.localAgent.cwdMissing": {
    zh: "找不到目录 {path}。",
    en: "Directory {path} doesn't exist.",
  },
  "error.localAgent.cwdNotDirectory": { zh: "{path} 不是目录。", en: "{path} isn't a directory." },
  "error.localAgent.cwdRequired": {
    zh: "工作区和完全访问权限需要指定工作目录。",
    en: "Workspace and full access need a working directory.",
  },
  "error.localAgent.cwdRoot": {
    zh: "不能把整个文件系统根目录作为工作目录。",
    en: "The file system root can't be the working directory.",
  },
  "error.localAgent.disabled": {
    zh: "本机 Agent 已在服务端关闭。",
    en: "Local agents are turned off on this server.",
  },
  "error.localAgent.mcpListFailed": {
    zh: "没能读取这个 Agent 的 MCP 列表。",
    en: "Couldn't read this agent's MCP servers.",
  },
  "error.localAgent.mcpListFailedReason": {
    zh: "没能读取这个 Agent 的 MCP 列表：{reason}",
    en: "Couldn't read this agent's MCP servers: {reason}",
  },
  "error.localAgent.mcpListTimedOut": {
    zh: "读取这个 Agent 的 MCP 列表超时（{seconds} 秒），可能是某个 MCP 启动太慢或模型服务繁忙，稍后再试。",
    en: "Reading this agent's MCP servers timed out ({seconds}s). An MCP may be slow to start or the model service busy; try again later.",
  },
  "error.localAgent.mcpUnsupported": {
    zh: "这个 Agent 类型暂不支持在 Hive 里开关 MCP。",
    en: "Hive can't turn MCP servers on or off for this kind of agent yet.",
  },
  "error.localAgent.effortUnsupported": {
    zh: "这个 Agent 类型暂不支持在 Hive 里切换思考强度。",
    en: "Hive can't change the reasoning effort for this kind of agent yet.",
  },
  "error.localAgent.contextUnsupported": {
    zh: "只有 Claude Code 能在 Hive 里设置自动压缩和缓存时长。",
    en: "Only Claude Code agents have auto-compact and cache duration settings in Hive.",
  },
  "error.localAgent.nameExists": {
    zh: "本机已有名为 {name} 的 Agent。",
    en: "There's already a local agent named {name}.",
  },
  "error.localAgent.nameInUse": {
    zh: "名称 {name} 已被其他成员使用，请换一个。",
    en: "{name} is already used by another member. Pick another.",
  },
  "error.localAgent.notFound": { zh: "找不到这个本机 Agent。", en: "Local agent not found." },
  "error.localAgent.notRemoved": {
    zh: "这个成员不是已移除的本机 Agent，或已经重新接入。请刷新成员列表。",
    en: "This member is not a removed local agent, or has already rejoined. Refresh the member list.",
  },
  "error.localAgent.restarting": { zh: "这个 Agent 正在重启。", en: "This agent is restarting." },
  "error.localAgent.restartingSettings": {
    zh: "这个 Agent 正在重启，等它启动后再改设置。",
    en: "This agent is restarting. Change its settings once it's up.",
  },
  "error.login.invalid": {
    zh: "登录链接无效、已过期或已经用过。请重新扫码，或在飞书里发 /web 获取新的链接。",
    en: "This sign-in link is invalid, expired, or already used. Scan again, or send /web in Feishu for a new link.",
  },
  "error.login.rateLimited": {
    zh: "尝试次数太多，请 10 分钟后再试。",
    en: "Too many attempts. Try again in 10 minutes.",
  },
  "error.member.notFound": { zh: "找不到这个成员。", en: "Member not found." },
  "error.message.empty": { zh: "消息内容为空。", en: "The message is empty." },
  // hopLimit / traceLimit：转交深度和单链条数上限已取消（rd #6608），留着只为显示旧记录里的原因
  "error.message.hopLimit": {
    zh: "这段 Agent 对话的转交深度已到上限。",
    en: "This agent conversation has been handed off too many times.",
  },
  "error.message.notInRoom": {
    zh: "这个房间里没有这条消息。",
    en: "There's no such message in this room.",
  },
  "error.message.parentMissing": {
    zh: "这个房间里没有要回复的那条消息。",
    en: "The message you're replying to isn't in this room.",
  },
  "error.message.rateLimit": {
    zh: "这个 Agent 发言太频繁，已到每分钟上限。",
    en: "This agent is replying too often and hit its per-minute limit.",
  },
  "error.message.recallSenderOnly": {
    zh: "只有发送者本人能撤回消息。",
    en: "Only the sender can unsend a message.",
  },
  "error.message.selfResponse": {
    zh: "Agent 不能回应自己发的消息。",
    en: "An agent can't respond to its own message.",
  },
  "error.message.tooLong": {
    zh: "消息超过 {max} 字符保护上限，请缩短正文或拆分发送。",
    en: "The message is over the {max}-character limit. Shorten it or split it into several messages.",
  },
  "error.message.traceLimit": {
    zh: "这条转交链里 Agent 发言已到上限。",
    en: "This agent conversation has reached its message limit.",
  },
  "error.message.unreadable": {
    zh: "当前房间/话题中没有这条可读取消息（可能已撤回）。",
    en: "There's no readable message like that in this room or topic (it may have been unsent).",
  },
  "error.name.agentFormat": {
    zh: "Agent 名字只能包含字母、数字、点、下划线和连字符。",
    en: "Agent names can only contain letters, numbers, dots, underscores, and hyphens.",
  },
  "error.name.format": {
    zh: "名字只能包含字母、数字、点、下划线和连字符。",
    en: "Names can only contain letters, numbers, dots, underscores, and hyphens.",
  },
  "error.name.online": {
    zh: "这个名字已经在房间里在线了。",
    en: "Someone with this name is already online in this room.",
  },
  "error.name.otherType": {
    zh: "这个名字已经被另一类成员（人或 Agent）使用。",
    en: "This name is already used by a different kind of member (person or agent).",
  },
  "error.name.taken": {
    zh: "房间里已经有这个名字了，请换一个。",
    en: "That name is already in use in this room. Pick another.",
  },
  "error.name.takenInRoom": {
    zh: "房间里已经有人用这个名字了，请换一个。",
    en: "Someone in this room already uses that name. Pick another.",
  },
  "error.progress.limit": {
    plural: "limit",
    zh: "这个任务的进度消息已经发了 {limit} 条，到上限了；把剩下的写进最终回复。",
    en: {
      one: "This task has already sent its {limit} progress update, the limit. Put the rest in your final reply.",
      other:
        "This task has already sent {limit} progress updates, the limit. Put the rest in your final reply.",
    },
  },
  "error.progress.mentionsAgent": {
    zh: "进度消息不会唤醒 {agents}；要别的 Agent 干活请用 hive_invoke，进度里提到它时去掉 @。",
    en: "Progress messages don't wake {agents}. Use hive_invoke to give another agent work, and drop the @ when you mention it in progress.",
  },
  "error.progress.outsideTask": {
    zh: "只能在执行任务的过程中发进度；最终结论请直接回复。",
    en: "You can only send progress while running a task. Reply directly with your final answer.",
  },
  "error.question.closed": {
    zh: "这个提问已经回答过或已停止等待。",
    en: "This question has already been answered or is no longer waiting.",
  },
  "error.question.duplicateOptions": { zh: "选项不能重复。", en: "Options must be unique." },
  "error.question.notFound": {
    zh: "这条提问不存在或没有可选项。",
    en: "This question doesn't exist or has no options.",
  },
  "error.question.optionCount": {
    zh: "选项需要 2 到 {max} 个；只有一个可选项时直接写在问题里。",
    en: "Questions need 2 to {max} options. If there's only one choice, put it in the question.",
  },
  "error.question.optionLength": {
    zh: "每个选项需为 1 到 {max} 个字符。",
    en: "Each option must be 1 to {max} characters.",
  },
  "error.request.invalid": { zh: "参数不正确。", en: "Invalid parameters." },
  "error.request.missingActor": { zh: "缺少操作人。", en: "The acting person is missing." },
  "error.agentCli.busy": {
    zh: "{tool} 正在升级，等它结束再试。一次只升级一个 CLI。",
    en: "{tool} is being updated. Wait for it to finish; only one CLI is updated at a time.",
  },
  "error.agentCli.planChanged": {
    zh: "{tool} 的安装情况变了，升级命令和你确认的不一样，没有执行。请刷新后重新确认。",
    en: "{tool}'s installation changed and the update command no longer matches what you confirmed, so nothing was run. Refresh and confirm again.",
  },
  "error.agentCli.notUpgradable": {
    zh: "{tool} 现在不能一键升级：{reason}",
    en: "{tool} can't be updated here: {reason}",
  },
  "error.agentCli.upToDate": {
    zh: "{tool} 已经是最新版（{version}）。",
    en: "{tool} is already up to date ({version}).",
  },
  "error.agentCli.nodeTooOld": {
    zh: "{tool} {latest} 需要 Node {required}，这台电脑用的是 Node {current}。先升级 Node 再来。",
    en: "{tool} {latest} requires Node {required}, but this computer uses Node {current}. Update Node first.",
  },
  "error.agentCli.versionUnchanged": {
    zh: "命令执行完了，但 {tool} 的版本还是 {version}，没有真的升级。可能是网络不通，或者装到了别处。",
    en: "The command finished, but {tool} is still {version}, so it wasn't actually updated. The network may be down, or it was installed somewhere else.",
  },
  "error.agentCli.versionUnknown": {
    zh: "命令执行完了，但检测不到 {tool} 的版本，不确定升级是否成功。",
    en: "The command finished, but {tool}'s version couldn't be detected, so it's unclear whether the update worked.",
  },
  "error.agentCli.alreadyInstalled": {
    zh: "{tool} 已经装好了，重新检测看看。",
    en: "{tool} is already installed. Check again.",
  },
  "error.agentCli.notInstallable": {
    zh: "{tool} 现在不能一键安装：{reason}",
    en: "{tool} can't be installed here: {reason}",
  },
  "agentCli.manual.noNode": {
    zh: "这台电脑上找不到 Node.js 和 npm，先装好 Node.js",
    en: "Node.js and npm weren't found on this computer; install Node.js first",
  },
  "error.agentCli.timeout": {
    zh: "升级超过 {minutes} 分钟还没结束，已停止。",
    en: "The update didn't finish within {minutes} minutes and was stopped.",
  },
  "error.agentCli.spawnFailed": {
    zh: "升级命令没能启动：{reason}",
    en: "The update command couldn't start: {reason}",
  },
  "error.agentCli.exitCode": {
    zh: "升级命令失败（退出码 {code}）。",
    en: "The update command failed (exit code {code}).",
  },
  "agentCli.manual.unknownSource": {
    zh: "认不出 {path} 是怎么装的，请用原来的安装方式升级",
    en: "Can't tell how {path} was installed; update it the way it was installed",
  },
  "agentCli.manual.noManager": {
    zh: "{path} 旁边找不到 {manager}，没法确定升级到哪一处，请用原来的安装方式升级",
    en: "{manager} wasn't found next to {path}, so the update can't be pinned to this installation; update it the way it was installed",
  },
  "agentCli.manual.nix": {
    zh: "通过 Nix 安装，请改 flake 后重新构建",
    en: "Installed with Nix; update your flake and rebuild",
  },
  "agentCli.manual.notOnPath": {
    zh: "登录 shell 的 PATH 里找不到 {tool}，不知道命令行用的是哪一处",
    en: "{tool} isn't on the login shell's PATH, so it's unclear which installation the command line uses",
  },
  "agentCli.manual.windows": {
    zh: "Windows 上暂不支持一键升级，请用原来的安装方式升级",
    en: "One-click updates aren't supported on Windows yet; update it the way it was installed",
  },
  "error.room.agentsAbsent": {
    zh: "#{room} 里还没有在线的 {agents}，稍后再试或换一个 Agent。",
    en: "{agents} isn't online in #{room} yet. Try again shortly or pick another agent.",
  },
  "error.room.archivedJoin": {
    zh: "这个房间已归档，不再接受新成员。",
    en: "This room is archived and no longer accepts new members.",
  },
  "error.room.clearMembersOnly": {
    zh: "只有房间里的人类成员可以清空房间。",
    en: "Only human members of this room can clear it.",
  },
  "error.room.whiteboardProtected": {
    zh: "白板还有 {count} 条仍占用工作区的事项，请先清理对应 worktree 再清空房间；也可以选择仅清空聊天、保留白板。本次未删除任何记录。",
    en: "The whiteboard has {count} items that still hold a worktree. Clean up those worktrees before clearing the room, or choose to clear chat only and keep the whiteboard. No records were deleted.",
  },
  "error.room.defaultProtected": {
    zh: "默认房间不能归档。",
    en: "The default room can't be archived.",
  },
  "error.room.exists": { zh: "已有这个 ID 的房间。", en: "A room with this ID already exists." },
  "error.room.existsForAgent": {
    zh: "已有 ID 是 {id} 的房间（显示名称「{name}」）。要往那个房间派活，直接用 hive_room_post；要新建就换一个 ID。",
    en: 'A room with the ID {id} already exists (display name "{name}"). To hand work to it, use hive_room_post; to create a new room, pick another ID.',
  },
  "error.room.guestAgentForbidden": {
    zh: "访客带入的 Agent 不能{action}。",
    en: "Agents brought in by a guest can't {action}.",
  },
  "error.room.leadInvalid": {
    zh: "{agent} 不是这个房间里的 Agent。",
    en: "{agent} isn't an agent in this room.",
  },
  "error.room.notFound": { zh: "房间不存在。", en: "Room not found." },
  "error.room.notFoundOrArchived": {
    zh: "房间不存在或已归档。",
    en: "The room doesn't exist or is archived.",
  },
  "error.room.notJoined": {
    zh: "你还没进入 #{room}，稍后再试。",
    en: "You haven't joined #{room} yet. Try again shortly.",
  },
  "error.room.outsideTask": {
    zh: "只能在处理某条消息的过程中{action}。",
    en: "You can only {action} while handling a message.",
  },
  "error.room.ownerTaskOnly": {
    zh: "只有房主本人发起的任务里才能{action}（访客发起的、Agent 之间的对话都不行）。",
    en: "You can only {action} in tasks the owner started (not in tasks started by guests or between agents).",
  },
  "error.room.postNeedsMention": {
    zh: "消息里要 @ 那个房间里接活的 Agent。",
    en: "@ the agent in that room who should take the task.",
  },
  "error.room.samePost": {
    zh: "这就是当前房间，直接回复或用 hive_invoke 即可。",
    en: "This is the current room. Reply directly or use hive_invoke.",
  },
  "error.room.targetNotFound": {
    zh: "没有 ID 或显示名称是「{room}」的房间（或已归档）。可用的房间：{candidates}。改用其中一个的 ID 重试。",
    en: "There's no room with the ID or display name \"{room}\" (or it's archived). Available rooms: {candidates}. Retry with one of these IDs.",
  },
  "error.room.targetNoneAvailable": {
    zh: "没有 ID 或显示名称是「{room}」的房间（或已归档），目前也没有别的可用房间。需要的话先用 hive_room_create 新建。",
    en: "There's no room with the ID or display name \"{room}\" (or it's archived), and there are no other rooms available. Create one with hive_room_create first if needed.",
  },
  "error.room.targetAmbiguous": {
    zh: "有多个房间的显示名称都是「{room}」：{candidates}。改用其中一个的 ID 重试。",
    en: 'More than one room is named "{room}": {candidates}. Retry with one of these IDs.',
  },
  "roomPost.candidate": { zh: "{id}（{name}）", en: "{id} ({name})" },
  "roomPost.candidateJoin": { zh: "{head}、{tail}", en: "{head}, {tail}" },
  "roomPost.candidatesMore": { zh: "{list}，还有 {more} 个", en: "{list}, and {more} more" },
  "error.schedule.humanOnly": {
    zh: "只有人发起的任务里才能创建定时任务（Agent 之间的对话不能自行排定时）。",
    en: "Scheduled tasks can only be created in tasks a person started (agents can't schedule each other).",
  },
  "error.schedule.intervalRange": {
    zh: "everyMinutes 需为 {min} 到 {max} 之间的整数（分钟）。",
    en: "everyMinutes must be a whole number from {min} to {max} (minutes).",
  },
  "error.schedule.missing": { zh: "定时任务不存在。", en: "Scheduled task not found." },
  "error.schedule.nested": {
    zh: "定时任务执行时不能再创建定时任务；要重复执行，请在最初创建时用 everyMinutes + until 登记成周期任务。",
    en: "A scheduled run can't create another scheduled task. To repeat, create a series up front with everyMinutes and until.",
  },
  "error.schedule.notFound": {
    zh: "这个房间里没有这个定时任务。",
    en: "There's no such scheduled task in this room.",
  },
  "error.schedule.outsideTask": {
    zh: "只能在处理某条消息的过程中创建定时任务。",
    en: "You can only create a scheduled task while handling a message.",
  },
  "error.schedule.ownOnly": {
    zh: "Agent 只能取消自己的定时任务。",
    en: "Agents can only cancel their own scheduled tasks.",
  },
  "error.schedule.requesterExpired": {
    zh: "发起人的访客权限已失效，不能再创建定时任务。",
    en: "The requester's guest access has expired, so no more scheduled tasks can be created.",
  },
  "error.schedule.roomLimit": {
    zh: "这个房间已有 {max} 个待执行的定时任务，先取消一些再建。",
    en: "This room already has {max} pending scheduled tasks. Cancel some first.",
  },
  "error.schedule.runAtFormat": {
    zh: "runAt 需为带时区偏移的 ISO 8601 时间，例如 2026-11-04T00:07:00+08:00。",
    en: "runAt must be an ISO 8601 time with a time zone offset, for example 2026-11-04T00:07:00+08:00.",
  },
  "error.schedule.runAtInvalid": { zh: "runAt 不是有效的时间。", en: "runAt isn't a valid time." },
  "error.schedule.runAtTooFar": {
    zh: "最多只能排到 {days} 天以内。",
    en: "Scheduled tasks can be at most {days} days ahead.",
  },
  "error.schedule.runAtTooSoon": {
    zh: "runAt 需晚于当前时间至少 30 秒；当前服务端时间 {now}。",
    en: "runAt must be at least 30 seconds from now. Server time is {now}.",
  },
  "error.schedule.taskLength": {
    zh: "任务说明需为 1 到 {max} 个字符。",
    en: "The task description must be 1 to {max} characters.",
  },
  "error.schedule.timeZone": {
    zh: "不认识的时区 {timeZone}，请用 IANA 名称，例如 Asia/Shanghai。",
    en: "Unknown time zone {timeZone}. Use an IANA name such as Asia/Shanghai.",
  },
  "error.schedule.tooManyOccurrences": {
    zh: "这样一共要执行 {count} 次，最多 {max} 次；请拉长间隔或提前结束时间。",
    en: "This would run {count} times; the maximum is {max}. Use a longer interval or an earlier end time.",
  },
  "error.schedule.untilBeforeRunAt": {
    zh: "until 需晚于第一次执行的时间 runAt。",
    en: "until must be later than the first run (runAt).",
  },
  "error.schedule.untilRequired": {
    zh: "周期任务要给 until：带时区偏移的 ISO 8601 结束时间，例如 2026-11-10T20:00:00+08:00。",
    en: "A series needs until: an ISO 8601 end time with a time zone offset, for example 2026-11-10T20:00:00+08:00.",
  },
  "error.schedule.untilTooFar": {
    zh: "周期最多只能排到 {days} 天以内。",
    en: "A series can run at most {days} days ahead.",
  },
  "error.steer.agentIdle": {
    zh: "{agent} 现在没有正在执行的任务，这条会照常开始。",
    en: "{agent} isn't running a task right now, so this message will start normally.",
  },
  "error.steer.humanOnly": {
    zh: "只有人直接发的消息可以用来引导当前任务。",
    en: "Only messages sent directly by a person can be added to the current task.",
  },
  "error.steer.messageGone": { zh: "这条消息已经不在了。", en: "This message no longer exists." },
  "error.steer.notQueued": {
    zh: "这条已经不在排队了。",
    en: "This message is no longer in the queue.",
  },
  "error.terminal.agentBusy": {
    zh: "{agent} 正在执行任务。终端里显示的是打开那一刻为止的会话记录，不会跟着刷新；在终端里发消息会和它同时写这个会话，把上下文搅乱。",
    en: "{agent} is running a task. The terminal shows the session as of when you open it and won't update; sending messages there writes to the same session at the same time and will scramble its context.",
  },
  "error.terminal.noSession": {
    zh: "{agent} 在这个房间还没有可以接着的会话：可能是它在支持这个功能之前启动的（重启一次就好）、在这个房间还没开始过任务，或这种 Agent 不支持。",
    en: "{agent} has no session to resume in this room. It may have started before this feature existed (restart it once), hasn't run a task in this room yet, or doesn't support it.",
  },
  "error.topic.humansOnly": {
    zh: "只有人能开启新话题。",
    en: "Only people can start a new topic.",
  },
  "error.ws.alreadyJoined": { zh: "已经加入过了。", en: "Already joined." },
  "error.ws.answerFailed": { zh: "回答没能提交。", en: "Couldn't submit the answer." },
  "error.ws.invalidEvent": { zh: "无效的请求。", en: "Invalid request." },
  "error.ws.invalidJson": {
    zh: "无法解析的消息格式。",
    en: "Couldn't read the message (invalid JSON).",
  },
  "error.ws.invalidToken": { zh: "接入令牌无效。", en: "The join token isn't valid." },
  "error.ws.joinFailed": { zh: "没能加入房间。", en: "Couldn't join the room." },
  "error.ws.notJoined": { zh: "请先加入房间。", en: "Join the room first." },
  "error.ws.recallFailed": { zh: "消息没能撤回。", en: "Couldn't unsend the message." },
  "error.ws.requestFailed": { zh: "请求没能处理。", en: "Couldn't handle the request." },
  "error.ws.sendFailed": { zh: "消息没能发出。", en: "Couldn't send the message." },

  /* ---------- IM 扫码与连接状态（网页 IM 弹窗显示；rd-claude2 维护） ---------- */
  "error.im.channelDisabled": { zh: "这个渠道没有启用。", en: "This channel isn't enabled." },
  "error.im.notMember": {
    zh: "需要以房间里的人类成员身份连接。",
    en: "Connect as a person who's a member of this room.",
  },
  "error.im.loginTimeout": {
    zh: "扫码超时，请重新开始。",
    en: "The QR code timed out. Start again.",
  },
  "error.im.noCodeNeeded": {
    zh: "当前不需要输入配对码。",
    en: "No pairing code is needed right now.",
  },
  "error.im.cancelled": { zh: "已取消", en: "Cancelled" },
  "error.im.wrongCode": {
    zh: "配对码不对，请重新输入。",
    en: "That pairing code is wrong. Enter it again.",
  },
  "error.im.takenByOther": {
    zh: "这个机器人已由另一个人连接，需要原来的人扫码，或先在原房间断开。",
    en: "Someone else already connected this bot. They need to scan the code, or disconnect it from its current room first.",
  },
  "error.im.noIdentity": {
    zh: "没有拿到扫码人的身份，请重试。",
    en: "Couldn't tell who scanned the code. Try again.",
  },
  "error.im.channelOff": {
    zh: "这个渠道已被关闭（HIVE_IM_WECHAT=0）。",
    en: "This channel has been turned off (HIVE_IM_WECHAT=0).",
  },
  "error.im.wechatBadAddress": {
    zh: "微信服务地址无效",
    en: "The WeChat service address isn't valid",
  },
  "error.im.wechatUnknownHost": {
    zh: "拒绝未知的微信服务地址：{host}",
    en: "Refused an unknown WeChat service address: {host}",
  },
  "error.im.wechatUnknownRedirect": {
    zh: "拒绝未知的微信跳转地址",
    en: "Refused an unknown WeChat redirect address",
  },
  "error.im.wechatSdkMismatch": {
    zh: "微信 SDK 版本不匹配",
    en: "The WeChat SDK version doesn't match",
  },
  "error.im.wechatSignedOut": {
    zh: "微信登录已失效，请重新扫码。",
    en: "Your WeChat sign-in is no longer valid. Scan the QR code again.",
  },
  "error.im.wechatExpired": {
    zh: "微信登录已过期，请重新扫码连接。",
    en: "Your WeChat sign-in expired. Scan the QR code again to reconnect.",
  },
  "error.im.wechatPollingStopped": {
    zh: "微信消息轮询已停止。",
    en: "Stopped checking WeChat for new messages.",
  },
  "error.im.feishuCode": { zh: "飞书返回错误 {code}", en: "Feishu returned error {code}" },
  "error.im.feishuNoImageKey": {
    zh: "飞书图片上传没有返回 image_key",
    en: "Feishu didn't return an image_key for the uploaded image",
  },
  "error.im.feishuNoFileKey": {
    zh: "飞书文件上传没有返回 file_key",
    en: "Feishu didn't return a file_key for the uploaded file",
  },
  "error.im.fileTooLarge": { zh: "文件超过 20 MiB", en: "The file is larger than 20 MiB" },

  /* ---------- 故障单 ---------- */
  "incident.dispatch": {
    zh: "@{agent} 🩺 故障单 {short}：{title}（Hive 代 {requester} 自动派修，第 {attempt} 次）\n来源：{source}；共出现 {count} 次，首次 {firstSeen}，最近 {lastSeen}；在跑的代码 {commit}\n最近一次的现场：\n{scene}\n请按这个流程修：\n1. 用 hive_worktree_create 建任务线（slug 用 incident-{short}）；\n2. 先写一个能复现的失败测试，确认它在修之前确实失败；\n3. 再改代码，跑全量测试和 lint；\n4. 提交信息末尾加一行「Incident: {short}」；\n5. 用 hive_incident_report 报 fixed（带提交号、分支，以及症状、原因、修法），再用 hive_invoke 交{reviewer} review；不要自己合入 main，合入由 review 方和人决定；\n6. 修不了、或判断不是代码问题，用 hive_incident_report 报 failed 并写清原因。\n不许改这些（权限、协作规则、门禁、审计、故障单系统本身）：{protected}；确实要改就用 hive_ask_human 找人。{lessons}\n（故障单 ID：{id}）",
    en: "@{agent} 🩺 Incident {short}: {title} (auto-assigned by Hive for {requester}, attempt {attempt})\nSource: {source}; seen {count} times, first {firstSeen}, latest {lastSeen}; running code {commit}\nLatest occurrence:\n{scene}\nFix it this way:\n1. Create a task line with hive_worktree_create (slug incident-{short}).\n2. First write a failing test that reproduces it, and confirm it fails before the fix.\n3. Then change the code and run the full test suite and lint.\n4. End the commit message with the line \"Incident: {short}\".\n5. Report fixed with hive_incident_report (commit, branch, symptom, cause, fix), then hand it to{reviewer} for review with hive_invoke. Don't merge into main yourself; the reviewer and a person decide.\n6. If you can't fix it, or it isn't a code problem, report failed with hive_incident_report and say why.\nDon't change these (permissions, collaboration rules, gates, audit, the incident system itself): {protected}. If you really must, ask a person with hive_ask_human.{lessons}\n(Incident ID: {id})",
  },
  "incident.reviewer": { zh: " {reviewer}", en: " {reviewer}" },
  "incident.reviewerAny": { zh: "负责 review 的 Agent", en: " the agent that does reviews" },
  "incident.lessons": {
    zh: "\n以前修过的类似问题（经验库，供参考，不一定适用）：\n{lessons}",
    en: "\nSimilar problems fixed before (from the lessons log; for reference, may not apply):\n{lessons}",
  },
  "incident.source.invocation": { zh: "Agent 调用失败", en: "Agent turn failed" },
  "incident.source.server": { zh: "Server 抛异常", en: "Server exception" },
  "incident.source.protocol": { zh: "协议校验失败", en: "Protocol validation failed" },
  "incident.source.web": { zh: "网页报错", en: "Web page error" },
  "incident.recurred": {
    zh: "@{requester} 🩺 故障单 {short} 修好后又出现了：{title}（共 {count} 次；Hive 代 {agent} 发出）\n修复提交 {commit} 已在跑的代码里，同一种错误还在出，已重新打开。可以考虑回滚这个提交；Hive 不会自动回滚。",
    en: "@{requester} 🩺 Incident {short} came back after the fix: {title} ({count} times in total; sent by Hive for {agent})\nFix commit {commit} is in the running code but the same error is still happening, so it's been reopened. Consider reverting that commit; Hive won't revert it automatically.",
  },
  "incident.escalated": {
    zh: "@{requester} 🩺 故障单 {short} 需要你处理：{title}（共 {count} 次；Hive 代 {agent} 发出）\n{reason}。自动修复已停下，在网页左侧「故障」面板里看现场，决定重新派修、忽略或手动处理。",
    en: "@{requester} 🩺 Incident {short} needs you: {title} ({count} times in total; sent by Hive for {agent})\n{reason}. Automatic fixing has stopped. See the details in the Incidents panel on the left of the web page and choose to reassign, ignore, or handle it yourself.",
  },
  "incident.note.recurred": {
    zh: "修复 {commit} 合入后又出现",
    en: "Came back after fix {commit} was merged",
  },
  "incident.note.escalatedAttempts": {
    zh: "已经修失败 {count} 次",
    en: { one: "Fixing failed {count} time", other: "Fixing failed {count} times" },
  },
  "incident.note.escalatedProtected": {
    zh: "修复动了不许自动改的代码：{files}",
    en: "The fix changed code that automatic fixes may not touch: {files}",
  },
  "incident.note.failed": { zh: "这次没修成：{reason}", en: "This attempt failed: {reason}" },
  "error.incident.notFound": { zh: "没有这张故障单。", en: "That incident wasn't found." },
  "error.incident.notAssigned": {
    zh: "这张故障单现在没有派给你修，不能回报。",
    en: "This incident isn't currently assigned to you, so you can't report on it.",
  },
  "error.incident.commitUnknown": {
    zh: "在 Server 的仓库里找不到这个提交；先提交到任务线的分支上，再用完整或至少 7 位的提交号回报。",
    en: "That commit isn't in the server's repository. Commit to your task branch first, then report with the full hash or at least 7 characters.",
  },
  "error.incident.notDispatchable": {
    zh: "现在不能派修：{reason}",
    en: "Can't assign this now: {reason}",
  },
  "error.incident.memberMissing": {
    zh: "派修设置里的人或 Agent 不在这个房间，先在网页左侧「故障」面板顶部的「派修设置」里改。",
    en: "The person or agent in the incident settings isn't in that room. Change this under Fixing settings at the top of the Incidents panel on the left of the web page first.",
  },
  "error.incident.fieldRequired": {
    zh: "缺少 {name}。",
    en: "{name} is required.",
  },
  "error.incident.disabled": {
    zh: "故障单没有启用。",
    en: "Incidents aren't enabled.",
  },
  "error.incident.rateLimited": {
    zh: "报错上报太频繁，稍后再试。",
    en: "Too many error reports. Try again later.",
  },
  "error.ruleProposal.notFound": {
    zh: "没有这条规则提议。",
    en: "That rule proposal wasn't found.",
  },
  "error.ruleProposal.decided": {
    zh: "这条提议已经处理过了。",
    en: "That proposal has already been handled.",
  },
  "error.ruleProposal.full": {
    zh: "待批准的规则提议已经有 20 条，等房主处理后再提。",
    en: "There are already 20 rule proposals waiting for the owner. Wait until they're handled.",
  },
} as const satisfies Record<string, Entry>;

export type ServerTextKey = keyof typeof serverTexts;

/** 参数值：字符串、数字，或嵌套的另一段文案（从库里读出的 detailText 是线上形状，同样可以嵌进来） */
export type ServerTextParam = string | number | ServerText | WireServerText;
export type ServerText = { key: ServerTextKey; params?: Record<string, ServerTextParam> };

/** 线上传的形状：key 用字符串而不是枚举，旧网页遇到新键时退回原文，不会整条事件校验失败 */
export type WireServerText = {
  key: string;
  params?: Record<string, WireServerTextParam> | undefined;
};
type WireServerTextParam = string | number | WireServerText;

export const serverTextSchema: z.ZodType<WireServerText> = z.lazy(() =>
  z
    .object({
      key: z.string().min(1).max(120),
      params: z.record(z.union([z.string().max(4000), z.number(), serverTextSchema])).optional(),
    })
    .strict(),
);

export function serverText(
  key: ServerTextKey,
  params?: Record<string, ServerTextParam>,
): ServerText {
  return params ? { key, params } : { key };
}

export function isServerTextKey(key: string): key is ServerTextKey {
  return Object.prototype.hasOwnProperty.call(serverTexts, key);
}

/**
 * 按语言渲染；键不认识（服务端比网页新）时返回 undefined，调用方退回原有的中文字段。
 * 缺英文时退回中文；参数缺失时占位符留空。
 */
export function renderServerText(
  text: WireServerText | undefined,
  locale: ServerLocale,
): string | undefined {
  if (!text || !isServerTextKey(text.key)) return undefined;
  const entry: Entry = serverTexts[text.key];
  return fillTemplate(serverTextTemplate(entry, locale, text.params), (name) => {
    const value = text.params?.[name];
    if (value === undefined) return "";
    if (typeof value === "object") return renderServerText(value, locale) ?? "";
    return String(value);
  });
}

/** 按语言（英文再按数量）挑模板；IM 的文案目录也用它，保证三边单复数规则一致 */
export function serverTextTemplate(
  entry: ServerTextEntry,
  locale: ServerLocale,
  params?: Record<string, unknown>,
): string {
  if (locale !== "en" || !entry.en) return entry.zh;
  if (typeof entry.en === "string") return entry.en;
  return isEnglishSingular(params?.[entry.plural ?? "count"]) ? entry.en.one : entry.en.other;
}

/** 填占位符 {name} */
export function fillTemplate(template: string, value: (name: string) => string): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => value(name));
}

/** 英文的所有写法（测试用：每种写法都要和中文占位符一致、不夹中文） */
export function englishForms(entry: ServerTextEntry): string[] {
  return typeof entry.en === "string" ? [entry.en] : [entry.en.one, entry.en.other];
}

/**
 * 带选项卡片的提问（hive_ask_human 带选项、权限申请）在网页气泡里只显示问题本身：
 * 完整正文里的单选 / 多选标记、逐行选项和作答提示已由选项卡片表达，再写一遍就重复了。
 * 复制、导出、IM 卡片和给 Agent 的上下文仍用完整正文；不是这两种提问时返回 undefined。
 */
export function questionBodyText(text: WireServerText | undefined): ServerText | undefined {
  const params = text?.params ?? {};
  const pick = (names: string[]) =>
    Object.fromEntries(
      names.flatMap((name) => (params[name] === undefined ? [] : [[name, params[name]!]])),
    );
  if (text?.key === "question.ask") return serverText("question.body", pick(["asker", "question"]));
  if (text?.key === "approval.request") {
    return serverText(
      "approval.body",
      pick(["asker", "agent", "tool", "summary", "detail", "minutes"]),
    );
  }
  return undefined;
}

/** 服务端写中文兼容字段用 */
export function zhText(text: ServerText): string {
  return renderServerText(text, "zh-CN") ?? "";
}

/** 模板里的占位符名（测试与检查用） */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}
