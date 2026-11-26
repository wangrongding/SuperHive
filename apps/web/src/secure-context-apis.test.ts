import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * crypto.randomUUID 只在安全上下文（HTTPS 或 localhost）里有。用局域网 IP、http 公网地址打开网页时它是 undefined，
 * 直接调会报「crypto.randomUUID is not a function」（rd #6712：粘贴/选附件时整个添加失败）。
 * 网页里一律走 client-id.ts 的 createClientMessageId，它在非安全上下文退回 getRandomValues。
 */
const SRC = path.dirname(new URL(import.meta.url).pathname);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("非安全上下文也能用的 API", () => {
  it("网页源码不直接调用 crypto.randomUUID（只在 client-id.ts 里带降级地用）", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => path.basename(file) !== "client-id.ts")
      .filter((file) => /crypto\s*\.\s*randomUUID\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
