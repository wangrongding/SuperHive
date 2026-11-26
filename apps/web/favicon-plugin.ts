import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export function hiveFavicon(): Plugin {
  const moduleId = "\0hive-favicon";
  let source: string;
  return {
    name: "hive-favicon",
    configResolved(config) {
      source = path.join(config.publicDir, "favicon.svg");
    },
    resolveId(id) {
      if (id === "virtual:hive-favicon") return moduleId;
    },
    load(id) {
      if (id !== moduleId) return;
      this.addWatchFile(source);
      return `export default ${JSON.stringify(readFileSync(source, "utf8"))};`;
    },
  };
}
