import aiIns from "@ai-ins/vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { hiveDevStatus } from "./dev-status-plugin";
import { pptxPreviewPatches } from "./pptx-preview-plugin";
import { hiveFavicon } from "./favicon-plugin";

const version = (
  JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, "../../packages/superhive/package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;
let commit: string | undefined;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    timeout: 5_000,
  }).trim();
} catch {
  commit = undefined;
}

export default defineConfig({
  define: { __HIVE_FEEDBACK_BUILD__: JSON.stringify({ version, commit }) },
  plugins: [aiIns(), react(), hiveDevStatus(), hiveFavicon(), pptxPreviewPatches()],
  // 开发时依赖预构建不走上面的 plugins，pptx-preview 的补丁要在这里再挂一次
  optimizeDeps: { rolldownOptions: { plugins: [pptxPreviewPatches()] } },
  server: { port: 5188 },
});
