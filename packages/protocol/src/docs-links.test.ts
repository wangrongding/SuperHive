import { describe, expect, it } from "vitest";
import { DOCS_BASE_URL, docsUrl } from "./docs-links.js";

describe("docsUrl", () => {
  it("中文走根路径，英文加 /en/，锚点按语言取", () => {
    expect(docsUrl("home")).toBe(DOCS_BASE_URL);
    expect(docsUrl("home", "en")).toBe(`${DOCS_BASE_URL}en/`);
    expect(docsUrl("im", "en")).toBe(`${DOCS_BASE_URL}en/guides/im/`);
    expect(docsUrl("permissions", "en")).toBe(
      `${DOCS_BASE_URL}en/guides/permissions/#choosing-a-level`,
    );
    expect(decodeURIComponent(docsUrl("permissions"))).toBe(
      `${DOCS_BASE_URL}guides/permissions/#选择档位`,
    );
  });
});
