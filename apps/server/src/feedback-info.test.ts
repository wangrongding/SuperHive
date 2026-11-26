import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { feedbackInfo } from "./feedback-info.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "hive-feedback-test-"));
  directories.push(root);
  return root;
}

describe("feedback build metadata", () => {
  it("exposes only the source package version, commit and distribution, not private package fields", async () => {
    const root = fixture();
    mkdirSync(path.join(root, "packages/superhive"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/superhive/package.json"),
      JSON.stringify({ name: "superhive", version: "0.4.8", token: "secret", privatePath: root }),
    );
    expect(await feedbackInfo("abcdef0123456789", path.join(root, "apps/server/src"))).toEqual({
      version: "0.4.8",
      commit: "abcdef0123456789",
      runMode: "source",
    });
  });
  it("recognizes the bundled npm layout and omits unknown commits", async () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "superhive", version: "0.4.8" }),
    );
    expect(await feedbackInfo(undefined, path.join(root, "dist/server"))).toEqual({
      version: "0.4.8",
      runMode: "npm",
    });
    expect(await feedbackInfo("secret", path.join(root, "dist/server"))).not.toHaveProperty(
      "commit",
    );
  });
  it("does not guess from unrelated packages or missing metadata", async () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "another-app", version: "secret" }),
    );
    expect(await feedbackInfo(undefined, path.join(root, "dist/server"))).toBeUndefined();
  });
});
