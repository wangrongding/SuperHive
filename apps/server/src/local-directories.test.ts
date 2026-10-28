import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandHome, launchDirectory, listDirectories } from "./local-directories.js";

describe("local directory browsing", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("expands ~ so typed paths work", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/project")).toBe(path.join(homedir(), "project"));
    expect(expandHome(" /tmp/x ")).toBe("/tmp/x");
    expect(expandHome("~user/x")).toBe("~user/x");
  });

  it("lists only directories, skips hidden ones and follows directory symlinks", () => {
    root = mkdtempSync(path.join(tmpdir(), "hive-dirs-"));
    mkdirSync(path.join(root, "apps"));
    mkdirSync(path.join(root, "packages"));
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, "README.md"), "x");
    symlinkSync(path.join(root, "apps"), path.join(root, "link-to-apps"));
    symlinkSync(path.join(root, "README.md"), path.join(root, "link-to-file"));

    const resolvedRoot = realpathSync(root);
    const listing = listDirectories(root);
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "apps",
      "link-to-apps",
      "packages",
    ]);
    expect(listing.path).toBe(resolvedRoot);
    expect(listing.parent).toBe(path.dirname(resolvedRoot));
    expect(listing.truncated).toBe(false);
    expect(listing.defaults.launch).toBe(launchDirectory());
  });

  it("defaults to the directory Hive was started in and reports the filesystem root", () => {
    expect(listDirectories().path).toBe(launchDirectory());
    expect(listDirectories("/").parent).toBeNull();
  });

  it("lets the launch directory be pinned, so dev mode can point at the repo root", () => {
    const original = process.env.HIVE_LAUNCH_DIR;
    try {
      process.env.HIVE_LAUNCH_DIR = tmpdir();
      expect(launchDirectory()).toBe(realpathSync(tmpdir()));
      expect(listDirectories().path).toBe(realpathSync(tmpdir()));
    } finally {
      if (original === undefined) delete process.env.HIVE_LAUNCH_DIR;
      else process.env.HIVE_LAUNCH_DIR = original;
    }
  });

  it("reports missing, relative and non-directory paths", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hive-dirs-"));
    root = directory;
    writeFileSync(path.join(directory, "file.txt"), "x");
    expect(() => listDirectories("relative/dir")).toThrow("绝对路径");
    expect(() => listDirectories(path.join(directory, "nope"))).toThrow("找不到目录");
    expect(() => listDirectories(path.join(directory, "file.txt"))).toThrow("不是目录");
  });
});
