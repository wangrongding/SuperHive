import { readFileSync, unwatchFile, watchFile } from "node:fs";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { DEV_STATUS_PATH, parseDevStatus } from "./src/dev-status";

/** 提供 dev supervisor 状态文件的查询接口；Vite 不随 Hive Server 重启，Server 挂掉时页面仍能读到状态 */
/**
 * dev supervisor 发布 protocol 产物时整个替换 dist 目录：Vite 的文件监听还挂在旧目录上，
 * 察觉不到新文件，会继续返回缓存的旧模块，页面因缺少新导出而白屏。
 * 这里按路径轮询入口文件（目录被替换后照样能读到新文件），变化时作废这些模块并让页面整页刷新。
 */
export function watchProtocolOutput(
  server: Pick<ViteDevServer, "moduleGraph" | "ws">,
  distDir: string,
  intervalMs = 500,
): () => void {
  const entry = path.join(distDir, "index.js");
  const onChange = (
    current: { mtimeMs: number; ino: number },
    previous: { mtimeMs: number; ino: number },
  ) => {
    if (current.mtimeMs === previous.mtimeMs && current.ino === previous.ino) return;
    let invalidated = 0;
    for (const module of Array.from(server.moduleGraph.idToModuleMap.values())) {
      if (module.file?.startsWith(distDir + path.sep)) {
        server.moduleGraph.invalidateModule(module);
        invalidated += 1;
      }
    }
    if (invalidated > 0) server.ws.send({ type: "full-reload" });
  };
  watchFile(entry, { interval: intervalMs }, onChange);
  return () => unwatchFile(entry, onChange);
}

export function hiveDevStatus(
  statusFile = path.resolve(import.meta.dirname, "../../.superhive-dev/status.json"),
  protocolDist = path.resolve(import.meta.dirname, "../../packages/protocol/dist"),
): Plugin {
  return {
    name: "hive-dev-status",
    apply: "serve",
    configureServer(server) {
      const stopWatching = watchProtocolOutput(server, protocolDist);
      server.httpServer?.once("close", stopWatching);
      server.middlewares.use(DEV_STATUS_PATH, (_request, response) => {
        let status;
        try {
          status = parseDevStatus(JSON.parse(readFileSync(statusFile, "utf8")));
        } catch {
          status = undefined;
        }
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify(status ?? null));
      });
    },
  };
}
