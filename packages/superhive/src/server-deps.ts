import { createRequire } from "node:module";

/**
 * better-sqlite3 是可选依赖：只有 Hive Server 用它，npx superhive join 在它装不上时也能把 Agent 带进别人的房间
 * （Windows 上 npx 重新装一份时，预编译包下载超时、本机又没装 VS 编译工具，以前会让整个安装失败）。
 * 启动 Server 前先试着加载一次，装不上就给出能照着做的提示，而不是后台进程起不来、只在日志里留一行 MODULE_NOT_FOUND。
 */
export function sqliteLoadError(
  load: () => void = () => {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3") as new (file: string) => { close(): void };
    new Database(":memory:").close();
  },
): string | undefined {
  try {
    load();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message.split("\n")[0] : String(error);
  }
}

export function sqliteMissingMessage(
  reason: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const mirror =
    platform === "win32"
      ? "set npm_config_better_sqlite3_binary_host_mirror=https://cdn.npmmirror.com/binaries/better-sqlite3"
      : "export npm_config_better_sqlite3_binary_host_mirror=https://cdn.npmmirror.com/binaries/better-sqlite3";
  return [
    `Hive Server 需要的数据库组件 better-sqlite3 没有装上（${reason}）。`,
    "只把 Agent 带进别人的房间（hive join）不需要它，可以照常用。",
    "要在这台电脑上运行 Server，请重新安装：npm i -g superhive@latest",
    `国内下载预编译包超时的话，先设置镜像再装：${mirror}`,
    "也可以直接安装桌面客户端，它自带 Server。",
  ].join("\n");
}
