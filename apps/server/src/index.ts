import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { buildApp } from "./app.js";

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
  process.env.HIVE_AGENT_COMMAND ?? (isDevRuntime ? "pnpm agent" : "npx --yes ai-hive");
mkdirSync(path.dirname(databasePath), { recursive: true });

const app = await buildApp({
  databasePath,
  publicUrl,
  agentCommandPrefix,
  ...(staticDir ? { staticDir } : {}),
  ...(instanceId ? { instanceId } : {}),
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
