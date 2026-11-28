import { defineConfig } from "@playwright/test";

// 冒烟测试起的 Server（包括打包好的应用）不记匿名使用统计：不往正式统计里发，也不碰 ~/.superhive/telemetry
process.env.SUPERHIVE_TELEMETRY = "0";

/** 冒烟测试：真的启动 Electron（.stage/app），用独立的数据目录和端口，不碰 ~/.superhive */
export default defineConfig({
  testDir: "test",
  testMatch: "**/*.smoke.ts",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
});
