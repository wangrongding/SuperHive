import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
// fileURLToPath：Windows 上 URL.pathname 是 /C:/...，不能当本机路径用
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

async function runCli(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cliPath, ...args]);
  return stdout;
}

// 每个用例都要冷启动 node + tsx，Windows 上单次要 3–4 秒
describe("service CLI", { timeout: 60_000 }, () => {
  it("lists restart in the top-level help", async () => {
    await expect(runCli("--help")).resolves.toContain("ai-hive restart [选项]");
  });

  it("documents restart configuration reuse and overrides", async () => {
    const output = await runCli("restart", "--help");
    expect(output).toContain("默认沿用上次启动时的 host、port 和 public-url");
    expect(output).toContain("--foreground");
  });

  it("documents the all-rooms default for join", async () => {
    const output = await runCli("join", "--help");
    expect(output).toContain("省略时加入服务器上所有未归档房间");
  });
});
