import "./socket-tos-guard.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageRootOf } from "./update.js";
import { webUpdateCommand } from "./web-update.js";

const packageRoot = packageRootOf(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  version: string;
};
const args = process.argv.slice(process.argv[2] === "web-update" ? 3 : 2);
webUpdateCommand(args, { packageRoot, version }).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
