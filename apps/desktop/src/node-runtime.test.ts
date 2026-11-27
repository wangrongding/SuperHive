import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error 打包脚本是纯 .mjs，没有类型声明
import * as runtime from "../scripts/node-runtime.mjs";

type Runtime = { version: string; sha256: Record<string, string> };
const { NODE_RUNTIME, ensureNodeRuntime, nodeArchive, parseShasums, verifyArchive } = runtime as {
  NODE_RUNTIME: Runtime;
  nodeArchive: (
    platform: string,
    arch: string,
    version?: string,
  ) => { file: string; url: string; target: string };
  parseShasums: (text: string) => Map<string, string>;
  verifyArchive: (input: {
    file: string;
    actual: string;
    pinned?: string | undefined;
    shasums: string;
  }) => void;
  ensureNodeRuntime: (
    options: Record<string, unknown>,
  ) => Promise<{ dir: string; cached: boolean }>;
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("bundled Node download", () => {
  it("pins an LTS build for Mac arm64 and Windows x64, named like the official archives", () => {
    expect(NODE_RUNTIME.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number(NODE_RUNTIME.version.split(".")[0]) % 2).toBe(0);
    expect(nodeArchive("darwin", "arm64")).toMatchObject({
      file: `node-v${NODE_RUNTIME.version}-darwin-arm64.tar.gz`,
      url: `https://nodejs.org/dist/v${NODE_RUNTIME.version}/node-v${NODE_RUNTIME.version}-darwin-arm64.tar.gz`,
    });
    expect(nodeArchive("win32", "x64").file).toBe(`node-v${NODE_RUNTIME.version}-win-x64.zip`);
    for (const target of ["darwin-arm64", "win-x64"]) {
      expect(NODE_RUNTIME.sha256[target]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("accepts only when pinned, official and downloaded hashes all agree", () => {
    const good = sha("archive");
    const shasums = `${sha("other")}  node-v1-win-x64.zip\n${good}  node-v1-darwin-arm64.tar.gz\n`;
    expect(parseShasums(shasums).get("node-v1-darwin-arm64.tar.gz")).toBe(good);
    const file = "node-v1-darwin-arm64.tar.gz";
    expect(() => verifyArchive({ file, actual: good, pinned: good, shasums })).not.toThrow();
    expect(() => verifyArchive({ file, actual: sha("tampered"), pinned: good, shasums })).toThrow(
      /SHA-256 mismatch/,
    );
    expect(() => verifyArchive({ file, actual: good, pinned: sha("x"), shasums })).toThrow(
      /does not match SHASUMS256/,
    );
    expect(() =>
      verifyArchive({ file: "node-v1-linux-x64.tar.gz", actual: good, pinned: good, shasums }),
    ).toThrow(/not listed/);
    expect(() => verifyArchive({ file, actual: good, pinned: undefined, shasums })).toThrow(
      /no pinned/,
    );
  });

  it("aborts staging on a bad download and leaves no unverified runtime behind", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "hive-node-runtime-"));
    dirs.push(root);
    const destDir = path.join(root, "stage/node");
    const good = "the real archive";
    const fake: Runtime = { version: "24.0.0", sha256: { "darwin-arm64": sha(good) } };
    const shasums = `${sha(good)}  node-v24.0.0-darwin-arm64.tar.gz\n`;
    let extracted = false;
    const options = {
      platform: "darwin",
      arch: "arm64",
      cacheDir: path.join(root, "cache"),
      destDir,
      runtime: fake,
      fetchText: async () => shasums,
      download: async (_url: string, dest: string) => writeFileSync(dest, "tampered archive"),
      extract: () => {
        extracted = true;
      },
      log: () => {},
    };
    await expect(ensureNodeRuntime(options)).rejects.toThrow(/SHA-256 mismatch/);
    expect(extracted).toBe(false);
    expect(existsSync(destDir)).toBe(false);
    // 坏的压缩包不留在缓存里，下次重新下载
    expect(existsSync(path.join(root, "cache/node-v24.0.0-darwin-arm64.tar.gz"))).toBe(false);

    // 下载对了：解压、裁剪、写版本戳；再跑一次直接复用
    const ok = {
      ...options,
      download: async (_url: string, dest: string) => writeFileSync(dest, good),
      extract: (_archive: string, dir: string) => {
        const base = path.join(dir, "node-v24.0.0-darwin-arm64");
        mkdirSync(path.join(base, "bin"), { recursive: true });
        mkdirSync(path.join(base, "include/node"), { recursive: true });
        writeFileSync(path.join(base, "bin/node"), "");
        writeFileSync(path.join(base, "bin/corepack"), "");
        symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", path.join(base, "bin/npm"));
      },
    };
    await expect(ensureNodeRuntime(ok)).resolves.toMatchObject({ dir: destDir, cached: false });
    expect(existsSync(path.join(destDir, "bin/node"))).toBe(true);
    expect(existsSync(path.join(destDir, "include"))).toBe(false);
    expect(existsSync(path.join(destDir, "bin/corepack"))).toBe(false);
    // 软链换成脚本：打包时软链会被改成构建机上的绝对路径
    expect(lstatSync(path.join(destDir, "bin/npm")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(destDir, "bin/npm"), "utf8")).toContain(
      '"$bin/node" "$bin/../lib/node_modules/npm/bin/npm-cli.js" "$@"',
    );
    await expect(ensureNodeRuntime(ok)).resolves.toMatchObject({ cached: true });
  });
});
