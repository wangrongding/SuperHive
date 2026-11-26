import { describe, expect, it } from "vitest";
import { findWindowsCommand, resolveCommand, windowsCommandLineLength } from "./windows-command.js";

const npm = "C:\\Users\\me\\AppData\\Roaming\\npm";
const env = { Path: `C:\\Windows\\system32;${npm}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

const exeShim = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;
const jsShim = `@ECHO off
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

function fs(files: Record<string, string>) {
  const lower = new Map(Object.entries(files).map(([name, text]) => [name.toLowerCase(), text]));
  return {
    isFile: (file: string) => lower.has(file.toLowerCase()),
    readFile: (file: string) => {
      const text = lower.get(file.toLowerCase());
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  };
}

describe("resolveCommand（Windows）", () => {
  it("leaves other platforms untouched", () => {
    expect(resolveCommand("claude", { platform: "darwin" })).toEqual({
      command: "claude",
      args: [],
    });
  });

  it("runs the exe behind an npm .cmd shim directly, without cmd.exe", () => {
    const files = fs({ [`${npm}\\claude.cmd`]: exeShim });
    expect(resolveCommand("claude", { platform: "win32", env, ...files })).toEqual({
      command: `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
      args: [],
    });
  });

  it("runs a .js shim target with node, preferring the node.exe next to the shim", () => {
    const files = fs({ [`${npm}\\codex.cmd`]: jsShim });
    expect(
      resolveCommand("codex", { platform: "win32", env, nodePath: "C:\\node\\node.exe", ...files }),
    ).toEqual({
      command: "C:\\node\\node.exe",
      args: [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`],
    });
    const withLocalNode = fs({ [`${npm}\\codex.cmd`]: jsShim, [`${npm}\\node.exe`]: "" });
    expect(resolveCommand("codex", { platform: "win32", env, ...withLocalNode }).command).toBe(
      `${npm}\\node.exe`,
    );
  });

  it("uses node.exe from PATH for Electron when the .cmd shim has no adjacent Node", () => {
    const nodeDir = "D:\\nvm\\nodejs";
    const electronEnv = { ...env, Path: `${nodeDir};${env.Path}` };
    const files = fs({
      [`${npm}\\codex.cmd`]: jsShim,
      [`${nodeDir}\\node.exe`]: "",
    });

    expect(
      resolveCommand("codex", {
        platform: "win32",
        env: electronEnv,
        isElectron: true,
        ...files,
      }),
    ).toEqual({
      command: `${nodeDir}\\node.exe`,
      args: [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`],
    });
  });

  it("fails clearly instead of trying to run a JavaScript shim with Electron", () => {
    const files = fs({ [`${npm}\\codex.cmd`]: jsShim });

    expect(() =>
      resolveCommand("codex", {
        platform: "win32",
        env,
        isElectron: true,
        ...files,
      }),
    ).toThrow(/没有在启动器目录或 PATH 中找到 node.exe/);
  });

  it("prefers a real .exe on PATH and refuses unknown batch files", () => {
    const files = fs({
      [`${npm}\\tool.exe`]: "",
      [`${npm}\\tool.cmd`]: exeShim,
      [`${npm}\\odd.bat`]: "echo hi",
    });
    expect(resolveCommand("tool", { platform: "win32", env, ...files }).command).toBe(
      `${npm}\\tool.exe`,
    );
    expect(() => resolveCommand("odd", { platform: "win32", env, ...files })).toThrow(
      /无法安全地直接运行/,
    );
  });

  it("leaves unknown commands as is so spawn reports ENOENT", () => {
    expect(resolveCommand("missing", { platform: "win32", env, ...fs({}) })).toEqual({
      command: "missing",
      args: [],
    });
    expect(findWindowsCommand("missing", env, () => false)).toBeUndefined();
  });

  it("estimates the command line length including quoting overhead", () => {
    expect(windowsCommandLineLength("a", ["b c", 'd"e'])).toBe(4 + 6 + 7);
  });
});
