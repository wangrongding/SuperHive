import { describe, expect, it } from "vitest";
import { pluginManifestSchema, satisfiesEngine } from "./plugin-manifest.js";

const base = {
  id: "dice",
  name: "骰子",
  version: "0.1.0",
  engines: { superhive: ">=0.4.0" },
  permissions: ["composer:write"],
  contributes: {
    panels: [{ id: "main", title: "骰子", entry: "panel.html" }],
    commands: [{ name: "roll", description: "掷骰子", panel: "main" }],
  },
};

describe("pluginManifestSchema", () => {
  it("接受合法清单并补默认值", () => {
    const manifest = pluginManifestSchema.parse(base);
    expect(manifest.guests).toBe(false);
    expect(manifest.contributes.mcpServers).toEqual([]);
  });

  it("拒绝不认识的权限和多余字段", () => {
    expect(pluginManifestSchema.safeParse({ ...base, permissions: ["shell:exec"] }).success).toBe(
      false,
    );
    expect(pluginManifestSchema.safeParse({ ...base, main: "index.js" }).success).toBe(false);
  });

  it("面板入口不能跳出插件目录", () => {
    for (const entry of ["../x.html", "/etc/a.html", "a/../../b.html", "panel.js"]) {
      const manifest = {
        ...base,
        contributes: { ...base.contributes, panels: [{ id: "main", title: "x", entry }] },
      };
      expect(pluginManifestSchema.safeParse(manifest).success, entry).toBe(false);
    }
  });

  it("命令必须指向存在的面板", () => {
    const manifest = {
      ...base,
      contributes: {
        ...base.contributes,
        commands: [{ name: "roll", description: "x", panel: "nope" }],
      },
    };
    expect(pluginManifestSchema.safeParse(manifest).success).toBe(false);
  });
});

describe("satisfiesEngine", () => {
  it.each([
    ["0.4.8", ">=0.4.0", true],
    ["0.4.8", "^0.4.0", true],
    ["0.5.0", "^0.4.0", false],
    ["1.2.0", "^1.0.0", true],
    ["2.0.0", "^1.0.0", false],
    ["0.4.8", "~0.4.2", true],
    ["0.4.8", ">=0.4.0 <0.5.0", true],
    ["0.5.1", ">=0.4.0 <0.5.0", false],
    ["0.4.8", "*", true],
    ["0.4.8", "latest", false],
  ])("%s 满足 %s → %s", (current, range, expected) => {
    expect(satisfiesEngine(current, range)).toBe(expected);
  });
});
