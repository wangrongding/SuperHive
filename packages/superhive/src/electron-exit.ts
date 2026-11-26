/**
 * 桌面端（Electron）里跑 CLI 时，命令做完进程不会自己退出：Electron 的消息循环一直开着。
 * Server 用 execFile 跑 `mcp list` / `models` / `--version` 要等进程退出才拿结果，挂着就要等到超时。
 * 所以在 Electron 里，除了常驻的 `join`（成功启动后靠自己的连接和信号处理收尾），命令做完就退出；
 * 出错了不管什么命令都退出。普通 node 里事件循环空了自然退出，不用管。
 */
export function shouldExitAfterCommand(options: {
  command: string | undefined;
  failed: boolean;
  electron: boolean;
  /** hive join --background：拉起后台进程后这个进程就该退出了 */
  background?: boolean;
}): boolean {
  if (!options.electron) return false;
  if (options.failed) return true;
  return options.command !== "join" || options.background === true;
}
