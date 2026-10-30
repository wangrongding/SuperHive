import { existsSync, mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { buildApp } from "./app.js";
import { feishuDriver } from "./im/feishu.js";
import type { ImChannelDriver } from "./im/types.js";

import type { AgentCli } from "./local-agents.js";

const host = process.env.HIVE_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.HIVE_PORT ?? "8787", 10);
const databasePath = process.env.HIVE_DATABASE ?? path.resolve("data/hive.sqlite");
const staticDir = process.env.HIVE_STATIC_DIR;
const instanceId = process.env.HIVE_INSTANCE_ID;
const lanAddresses: string[] = [];
for (const entries of Object.values(networkInterfaces())) {
  for (const entry of entries ?? []) {
    if (entry.family === "IPv4" && !entry.internal) lanAddresses.push(entry.address);
  }
}
const detectedHost = host === "0.0.0.0" || host === "::" ? (lanAddresses[0] ?? "localhost") : host;
const detectedUrl = `http://${detectedHost.includes(":") ? `[${detectedHost}]` : detectedHost}:${port}`;
const publicUrl = (process.env.HIVE_PUBLIC_URL ?? detectedUrl).replace(/\/$/, "");
// 开发模式（tsx 直接运行 src/）默认生成仓库本地命令；构建产物（dist/）默认生成已发布的 npx 命令。
const isDevRuntime = import.meta.dirname.endsWith(`${path.sep}src`);
const agentCommandPrefix =
  process.env.HIVE_AGENT_COMMAND ?? (isDevRuntime ? "pnpm agent" : "npx --yes ai-hive@latest");
mkdirSync(path.dirname(databasePath), { recursive: true });

/**
 * 本机 Agent 用同一份 ai-hive CLI 拉起：开发时走 tsx 运行仓库源码，打包后用同包内的 dist/cli.js，
 * 都不经过 npx，不依赖网络。HIVE_LOCAL_AGENTS=0 可整体关闭。
 */
// 开发模式下 pnpm 的 cwd 是 apps/server；本机 Agent 的默认工作目录应该是仓库根目录
if (isDevRuntime && !process.env.HIVE_LAUNCH_DIR) {
  process.env.HIVE_LAUNCH_DIR = path.resolve(import.meta.dirname, "../../..");
}

function localAgentCli(): AgentCli | undefined {
  if (isDevRuntime) {
    return {
      command: process.execPath,
      args: [
        "--import",
        import.meta.resolve("tsx"),
        path.resolve(import.meta.dirname, "../../../packages/ai-hive/src/cli.ts"),
      ],
    };
  }
  const cli = path.resolve(import.meta.dirname, "../cli.js");
  return existsSync(cli) ? { command: process.execPath, args: [cli] } : undefined;
}
const agentCli = process.env.HIVE_LOCAL_AGENTS === "0" ? undefined : localAgentCli();
// 本机 Agent 走回环地址连接，不受局域网 IP 变化影响；只监听了指定网卡时用那个地址
const loopbackHost = ["0.0.0.0", "::", "localhost", "127.0.0.1"].includes(host)
  ? "127.0.0.1"
  : host;
const localServerUrl = `http://${loopbackHost.includes(":") ? `[${loopbackHost}]` : loopbackHost}:${port}`;

// 个人微信走非官方通道：HIVE_IM_WECHAT=0 时整体不加载（网页上也不显示这个选项）
const imDrivers: Partial<Record<"feishu" | "wechat", ImChannelDriver>> = {
  feishu: feishuDriver,
  ...(process.env.HIVE_IM_WECHAT === "0"
    ? {}
    : { wechat: (await import("./im/wechat.js")).wechatDriver }),
};

const app = await buildApp({
  databasePath,
  imDrivers,
  imKeyPath: path.join(path.dirname(databasePath), "im-secret.key"),
  publicUrl,
  agentCommandPrefix,
  ...(staticDir ? { staticDir } : {}),
  ...(instanceId ? { instanceId } : {}),
  ...(agentCli ? { localAgents: { cli: agentCli, serverUrl: localServerUrl } } : {}),
  logger: true,
});
await app.listen({ host, port });

const addresses = new Set([
  publicUrl,
  ...lanAddresses.map((address) => `http://${address}:${port}`),
  `http://localhost:${port}`,
]);

app.log.info("AI Hive is ready");
app.log.info(`Share URL: ${publicUrl}`);
for (const address of addresses) app.log.info(`Web: ${address}`);
app.log.info(
  `Agent: ${agentCommandPrefix} join --server ${publicUrl} --name my-agent --token <JOIN_TOKEN>`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}
