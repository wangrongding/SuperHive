import { describe, expect, it, vi } from "vitest";
import { handleSquirrelEvent, squirrelEvent, updateExeArgs, updateExePath } from "./squirrel.js";

const execPath = "C:\\Users\\a\\AppData\\Local\\SuperHive\\app-0.4.4\\SuperHive.exe";

describe("squirrel events", () => {
  it("recognizes the installer events only as the first argument", () => {
    expect(squirrelEvent([execPath, "--squirrel-install", "0.4.4"])).toBe("install");
    expect(squirrelEvent([execPath, "--squirrel-updated", "0.4.5"])).toBe("updated");
    expect(squirrelEvent([execPath, "--squirrel-uninstall"])).toBe("uninstall");
    expect(squirrelEvent([execPath, "--squirrel-obsolete"])).toBe("obsolete");
    expect(squirrelEvent([execPath, "--squirrel-firstrun"])).toBeUndefined();
    expect(squirrelEvent([execPath, "--superhive-cli", "--squirrel-install"])).toBeUndefined();
  });

  it("creates shortcuts on install/update and removes them on uninstall via Update.exe", () => {
    expect(updateExePath(execPath)).toBe("C:\\Users\\a\\AppData\\Local\\SuperHive\\Update.exe");
    expect(updateExeArgs("install", execPath)).toEqual(["--createShortcut=SuperHive.exe"]);
    expect(updateExeArgs("updated", execPath)).toEqual(["--createShortcut=SuperHive.exe"]);
    expect(updateExeArgs("uninstall", execPath)).toEqual(["--removeShortcut=SuperHive.exe"]);
    expect(updateExeArgs("obsolete", execPath)).toBeUndefined();
  });

  it("unregisters superhive:// before removing shortcuts on uninstall, and never blocks it", () => {
    const order: string[] = [];
    const run = vi.fn((_command: string, args: string[], done: () => void) => {
      order.push(args[0]!);
      done();
    });
    const quit = vi.fn();
    const onUninstall = vi.fn(() => {
      order.push("unregister");
    });
    handleSquirrelEvent({
      platform: "win32",
      argv: [execPath, "--squirrel-uninstall"],
      execPath,
      run,
      quit,
      onUninstall,
    });
    expect(order).toEqual(["unregister", "--removeShortcut=SuperHive.exe"]);
    expect(quit).toHaveBeenCalledTimes(1);

    // 清理抛错也照样删快捷方式、退出
    const failingQuit = vi.fn();
    handleSquirrelEvent({
      platform: "win32",
      argv: [execPath, "--squirrel-uninstall"],
      execPath,
      run,
      quit: failingQuit,
      onUninstall: () => {
        throw new Error("registry denied");
      },
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(failingQuit).toHaveBeenCalledTimes(1);

    // 安装、更新时不清
    for (const arg of ["--squirrel-install", "--squirrel-updated", "--squirrel-obsolete"]) {
      handleSquirrelEvent({
        platform: "win32",
        argv: [execPath, arg],
        execPath,
        run,
        quit,
        onUninstall,
      });
    }
    expect(onUninstall).toHaveBeenCalledTimes(1);
  });

  it("runs Update.exe then quits, and leaves normal launches alone", () => {
    const quit = vi.fn();
    const run = vi.fn((_command: string, _args: string[], done: () => void) => {
      done();
      done();
    });
    expect(
      handleSquirrelEvent({
        platform: "win32",
        argv: [execPath, "--squirrel-install"],
        execPath,
        run,
        quit,
      }),
    ).toBe(true);
    expect(run).toHaveBeenCalledWith(
      "C:\\Users\\a\\AppData\\Local\\SuperHive\\Update.exe",
      ["--createShortcut=SuperHive.exe"],
      expect.any(Function),
    );
    expect(quit).toHaveBeenCalledTimes(1);

    const obsoleteQuit = vi.fn();
    expect(
      handleSquirrelEvent({
        platform: "win32",
        argv: [execPath, "--squirrel-obsolete"],
        execPath,
        run,
        quit: obsoleteQuit,
      }),
    ).toBe(true);
    expect(obsoleteQuit).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);

    const untouched = vi.fn();
    expect(
      handleSquirrelEvent({
        platform: "win32",
        argv: [execPath],
        execPath,
        run: untouched,
        quit: untouched,
      }),
    ).toBe(false);
    expect(
      handleSquirrelEvent({
        platform: "darwin",
        argv: [execPath, "--squirrel-install"],
        execPath,
        run: untouched,
        quit: untouched,
      }),
    ).toBe(false);
    expect(untouched).not.toHaveBeenCalled();
  });
});
