import { describe, expect, it } from "vitest";
import { sqliteLoadError, sqliteMissingMessage } from "./server-deps.js";

describe("sqliteLoadError", () => {
  it("is undefined when better-sqlite3 loads", () => {
    expect(sqliteLoadError()).toBeUndefined();
    expect(sqliteLoadError(() => undefined)).toBeUndefined();
  });

  it("returns the first line of the load error", () => {
    expect(
      sqliteLoadError(() => {
        throw new Error("Cannot find module 'better-sqlite3'\nRequire stack:\n- x");
      }),
    ).toBe("Cannot find module 'better-sqlite3'");
  });
});

describe("sqliteMissingMessage", () => {
  it("says join still works and how to reinstall, with the shell syntax of the platform", () => {
    const win = sqliteMissingMessage("boom", "win32");
    expect(win).toContain("boom");
    expect(win).toContain("hive join");
    expect(win).toContain("npm i -g superhive@latest");
    expect(win).toContain("set npm_config_better_sqlite3_binary_host_mirror=");
    expect(sqliteMissingMessage("boom", "darwin")).toContain(
      "export npm_config_better_sqlite3_binary_host_mirror=",
    );
  });
});
