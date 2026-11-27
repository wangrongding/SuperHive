import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { keychainSwitches, MOCK_KEYCHAIN_SWITCH } from "./keychain.js";

const srcDir = import.meta.dirname;
const read = (file: string) => readFileSync(path.join(srcDir, file), "utf8");

describe("keychainSwitches", () => {
  it("只在 macOS 上让 Chromium 用假钥匙串", () => {
    expect(keychainSwitches("darwin")).toEqual([MOCK_KEYCHAIN_SWITCH]);
    expect(MOCK_KEYCHAIN_SWITCH).toBe("use-mock-keychain");
    // Windows 的 cookie 加密走 DPAPI，不弹框，保持真加密
    expect(keychainSwitches("win32")).toEqual([]);
    expect(keychainSwitches("linux")).toEqual([]);
  });

  it("主进程在分流到桌面端 / 命令行模式之前、模块顶层就加上开关", () => {
    const main = read("main.ts");
    const apply = main.indexOf(
      "for (const name of keychainSwitches(process.platform)) app.commandLine.appendSwitch(name);",
    );
    expect(apply).toBeGreaterThan(0);
    // 顶层语句：行首没有缩进；在 runCli / runApp 被调用之前
    expect(main.slice(main.lastIndexOf("\n", apply) + 1, apply)).toBe("");
    expect(apply).toBeLessThan(main.indexOf("const cliIndex = process.argv.indexOf(CLI_FLAG);"));
    expect(apply).toBeLessThan(main.indexOf("void runCli("));
    expect(apply).toBeLessThan(main.indexOf("  runApp();"));
  });

  it("开关还在时不能用 safeStorage：Mac 上它拿到的是固定密钥，等于没加密", () => {
    const sources = readdirSync(srcDir).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "keychain.ts",
    );
    expect(sources).toContain("main.ts");
    const users = sources.filter((file) => /\bsafeStorage\b/.test(read(file)));
    expect(users).toEqual([]);
  });
});
