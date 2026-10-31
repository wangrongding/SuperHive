import { describe, expect, it } from "vitest";
import { shellQuote } from "./service.js";

describe("shellQuote", () => {
  it("keeps Windows backslashes as they are and only quotes when needed", () => {
    expect(shellQuote("C:\\Users\\me\\data", "win32")).toBe("C:\\Users\\me\\data");
    expect(shellQuote("C:\\Users\\me\\hive data", "win32")).toBe('"C:\\Users\\me\\hive data"');
    expect(shellQuote("/Users/me/data", "darwin")).toBe("/Users/me/data");
    expect(shellQuote("/Users/me/my data", "darwin")).toBe("'/Users/me/my data'");
    expect(shellQuote("/Users/it's", "darwin")).toBe("'/Users/it'\\''s'");
  });
});
