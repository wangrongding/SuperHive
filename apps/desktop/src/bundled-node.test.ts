import { describe, expect, it } from "vitest";
import {
  agentClisBin,
  appendPath,
  bundledNodeBinary,
  bundledRuntime,
  bundledRuntimeEnv,
} from "./bundled-node.js";

describe("bundled Node runtime", () => {
  it("lives in resources/node when packaged and next to the stage app in development", () => {
    const seen: string[] = [];
    const exists = (file: string) => (seen.push(file), true);
    expect(
      bundledRuntime({
        isPackaged: true,
        resourcesPath: "/Applications/SuperHive.app/Contents/Resources",
        appRoot: "/Applications/SuperHive.app/Contents/Resources/app.asar",
        userData: "/Users/me/Library/Application Support/SuperHive",
        platform: "darwin",
        exists,
      }),
    ).toEqual({
      node: "/Applications/SuperHive.app/Contents/Resources/node/bin/node",
      agentClisDir: "/Users/me/Library/Application Support/SuperHive/agent-clis",
    });
    expect(
      bundledRuntime({
        isPackaged: false,
        resourcesPath: "/x",
        appRoot: "/repo/apps/desktop/.stage/app",
        userData: "/u",
        platform: "darwin",
        exists: () => false,
      }),
    ).toEqual({ node: undefined, agentClisDir: "/u/agent-clis" });
    expect(bundledNodeBinary("C:\\SuperHive\\resources\\node", "win32")).toBe(
      "C:\\SuperHive\\resources\\node\\node.exe",
    );
    expect(agentClisBin("/u/agent-clis", "darwin")).toBe("/u/agent-clis/bin");
    expect(agentClisBin("C:\\u\\agent-clis", "win32")).toBe("C:\\u\\agent-clis");
  });

  it("appends to the END of PATH so the user's own node wins, without duplicates", () => {
    expect(appendPath("/opt/homebrew/bin:/usr/bin", ["/n/bin", "/usr/bin"], "darwin")).toBe(
      "/opt/homebrew/bin:/usr/bin:/n/bin",
    );
    expect(appendPath("C:\\Node;C:\\Windows", ["c:\\node", "D:\\x"], "win32")).toBe(
      "C:\\Node;C:\\Windows;D:\\x",
    );
    expect(appendPath("", ["/n/bin"], "linux")).toBe("/n/bin");
  });

  it("hands the Server the node path, the agent-clis prefix and an extended PATH", () => {
    expect(
      bundledRuntimeEnv(
        { node: "/R/node/bin/node", agentClisDir: "/U/agent-clis" },
        { PATH: "/usr/local/bin:/usr/bin" },
        "darwin",
      ),
    ).toEqual({
      SUPERHIVE_BUNDLED_NODE: "/R/node/bin/node",
      SUPERHIVE_AGENT_CLIS_DIR: "/U/agent-clis",
      PATH: "/usr/local/bin:/usr/bin:/U/agent-clis/bin:/R/node/bin",
    });
    // Windows：沿用已有的 Path 键，不再多出一个 PATH
    expect(
      bundledRuntimeEnv(
        { node: "C:\\R\\node\\node.exe", agentClisDir: "C:\\U\\agent-clis" },
        { Path: "C:\\Windows" },
        "win32",
      ),
    ).toEqual({
      SUPERHIVE_BUNDLED_NODE: "C:\\R\\node\\node.exe",
      SUPERHIVE_AGENT_CLIS_DIR: "C:\\U\\agent-clis",
      Path: "C:\\Windows;C:\\U\\agent-clis;C:\\R\\node",
    });
    // 没有自带 Node（开发时跳过了下载）：不设 SUPERHIVE_BUNDLED_NODE
    expect(
      bundledRuntimeEnv({ node: undefined, agentClisDir: "/U/a" }, { PATH: "/usr/bin" }, "linux"),
    ).toEqual({ SUPERHIVE_AGENT_CLIS_DIR: "/U/a", PATH: "/usr/bin:/U/a/bin" });
  });
});
