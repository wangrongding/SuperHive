// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { migrateLegacyStorage } from "./storage-migration";

describe("migrateLegacyStorage", () => {
  it("把旧前缀的键搬到新前缀，已有的新值不覆盖", () => {
    localStorage.clear();
    localStorage.setItem("ai-hive.username", "rd");
    localStorage.setItem("ai-hive.theme", "dark");
    localStorage.setItem("superhive.theme", "light");
    localStorage.setItem("other", "keep");
    migrateLegacyStorage(localStorage);
    expect(localStorage.getItem("superhive.username")).toBe("rd");
    expect(localStorage.getItem("superhive.theme")).toBe("light");
    expect(localStorage.getItem("ai-hive.username")).toBeNull();
    expect(localStorage.getItem("ai-hive.theme")).toBeNull();
    expect(localStorage.getItem("other")).toBe("keep");
  });
});
