import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { DEV_STATUS_PATH, parseDevStatus } from "./src/dev-status";

/** 提供 dev supervisor 状态文件的查询接口；Vite 不随 Hive Server 重启，Server 挂掉时页面仍能读到状态 */
export function hiveDevStatus(
  statusFile = path.resolve(import.meta.dirname, "../../.ai-hive-dev/status.json"),
): Plugin {
  return {
    name: "hive-dev-status",
    apply: "serve",
    configureServer(server) {
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
