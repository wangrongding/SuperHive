import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { superhiveHome } from "./home-dir.js";

const legacyName = ".ai-hive";

describe("superhiveHome", () => {
  it("没有任何旧数据时返回 ~/.superhive", () => {
    const home = mkdtempSync(path.join(tmpdir(), "superhive-home-"));
    expect(superhiveHome(home)).toBe(path.join(home, ".superhive"));
  });

  it("只有旧目录时迁移过来，旧位置留链接", () => {
    const home = mkdtempSync(path.join(tmpdir(), "superhive-home-"));
    mkdirSync(path.join(home, legacyName, "agents"), { recursive: true });
    writeFileSync(path.join(home, legacyName, "hive.sqlite"), "db");
    const result = superhiveHome(home);
    expect(result).toBe(path.join(home, ".superhive"));
    expect(readFileSync(path.join(result, "hive.sqlite"), "utf8")).toBe("db");
    expect(existsSync(path.join(result, "agents"))).toBe(true);
    expect(lstatSync(path.join(home, legacyName)).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(home, legacyName, "hive.sqlite"), "utf8")).toBe("db");
  });

  it("新目录已存在时不动旧目录", () => {
    const home = mkdtempSync(path.join(tmpdir(), "superhive-home-"));
    mkdirSync(path.join(home, ".superhive"));
    mkdirSync(path.join(home, legacyName));
    expect(superhiveHome(home)).toBe(path.join(home, ".superhive"));
    expect(lstatSync(path.join(home, legacyName)).isDirectory()).toBe(true);
  });
});
