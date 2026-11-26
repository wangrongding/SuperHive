import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  quoteWindowsArg,
  spawnBackground,
  windowsCommandLineArgs,
  WINDOWS_LAUNCH_SCRIPT,
  type BackgroundSpawn,
} from "./background-process.js";

type Call = { command: string; args: string[]; options: Record<string, unknown> };

function fakeSpawn(
  onSpawn: (call: Call, child: EventEmitter & { pid: number | undefined }) => void,
) {
  const calls: Call[] = [];
  const impl = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined as number | undefined,
      unref: vi.fn(),
    });
    const call = { command, args, options };
    calls.push(call);
    onSpawn(call, child);
    return child;
  }) as unknown as BackgroundSpawn;
  return { impl, calls };
}

describe("spawnBackground", () => {
  it("keeps the detached launch with the log file on macOS and Linux", async () => {
    const { impl, calls } = fakeSpawn((_call, child) => (child.pid = 4242));
    const launched = spawnBackground(
      "/usr/bin/node",
      ["cli.js", "join"],
      { cwd: "/home/me", env: { A: "1" }, logFd: 9 },
      "darwin",
      impl,
    );
    await expect(launched.pid).resolves.toBe(4242);
    expect(launched.child).toBeDefined();
    expect(calls).toEqual([
      {
        command: "/usr/bin/node",
        args: ["cli.js", "join"],
        options: {
          cwd: "/home/me",
          env: { A: "1" },
          detached: true,
          stdio: ["ignore", 9, 9],
          windowsHide: true,
        },
      },
    ]);
  });

  it("on Windows goes through a hidden PowerShell so the process gets a hidden console and outlives its parent", async () => {
    const { impl, calls } = fakeSpawn((call, child) => {
      // PowerShell 把真正的 pid 写进文件后退出
      setImmediate(() => {
        writeFileSync(String((call.options.env as NodeJS.ProcessEnv).HIVE_BG_PID_FILE), "31337");
        child.emit("close", 0);
      });
    });
    const launched = spawnBackground(
      "C:\\Program Files\\nodejs\\node.exe",
      ["C:\\npm\\superhive\\dist\\cli.js", "join", "--name=菜包 claude"],
      { cwd: "C:\\Users\\me", env: { SystemRoot: "Z:\\nope", A: "1" }, logFd: 7 },
      "win32",
      impl,
    );
    await expect(launched.pid).resolves.toBe(31337);
    expect(launched.child).toBeUndefined();
    const [call] = calls;
    expect(call!.command).toBe("powershell.exe");
    expect(call!.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_LAUNCH_SCRIPT,
    ]);
    // 不 detached（否则没有控制台）、windowsHide（控制台不可见）、日志句柄交给 PowerShell 再由真正的进程继承
    expect(call!.options).toMatchObject({
      detached: false,
      windowsHide: true,
      stdio: ["ignore", 7, 7],
    });
    expect(call!.options.env).toMatchObject({
      A: "1",
      HIVE_BG_FILE: "C:\\Program Files\\nodejs\\node.exe",
      HIVE_BG_ARGS: 'C:\\npm\\superhive\\dist\\cli.js join "--name=菜包 claude"',
      HIVE_BG_CWD: "C:\\Users\\me",
    });
    expect(WINDOWS_LAUNCH_SCRIPT).toContain("Start-Process @launch");
    expect(WINDOWS_LAUNCH_SCRIPT).toContain("NoNewWindow = $true");
    // 启动参数用完即删，不让真正的进程继承
    expect(WINDOWS_LAUNCH_SCRIPT).toMatch(/Remove-Item Env:HIVE_BG_FILE.*\$p = Start-Process/);
  });

  it("on Windows can run in its own hidden console so callers waiting on pipes aren't held up", async () => {
    const { impl, calls } = fakeSpawn((call, child) => {
      setImmediate(() => {
        writeFileSync(String((call.options.env as NodeJS.ProcessEnv).HIVE_BG_PID_FILE), "4040");
        child.emit("close", 0);
      });
    });
    const launched = spawnBackground(
      "node.exe",
      ["cli.js"],
      { env: {}, logFd: 7, windowsOwnConsole: true },
      "win32",
      impl,
    );
    await expect(launched.pid).resolves.toBe(4040);
    expect(calls[0]!.options.env).toMatchObject({ HIVE_BG_OWN_CONSOLE: "1" });
    expect(WINDOWS_LAUNCH_SCRIPT).toContain(
      "if ($env:HIVE_BG_OWN_CONSOLE) { $launch.WindowStyle = 'Hidden' } else { $launch.NoNewWindow = $true }",
    );
    expect(WINDOWS_LAUNCH_SCRIPT).toMatch(/Remove-Item [^;]*Env:HIVE_BG_OWN_CONSOLE/);
    // 默认不变：共用 PowerShell 的隐藏控制台
    const plain = fakeSpawn((call, child) => {
      setImmediate(() => {
        writeFileSync(String((call.options.env as NodeJS.ProcessEnv).HIVE_BG_PID_FILE), "4041");
        child.emit("close", 0);
      });
    });
    await spawnBackground("node.exe", [], { env: {}, logFd: 7 }, "win32", plain.impl).pid;
    expect(plain.calls[0]!.options.env).not.toHaveProperty("HIVE_BG_OWN_CONSOLE");
  });

  it("on Windows rejects when PowerShell could not start the process", async () => {
    const { impl } = fakeSpawn((_call, child) => setImmediate(() => child.emit("close", 1)));
    const launched = spawnBackground("missing.exe", [], { logFd: 3, env: {} }, "win32", impl);
    await expect(launched.pid).rejects.toThrow(/missing\.exe/);
  });
});

describe("Windows command line quoting", () => {
  it("follows the CommandLineToArgvW rules", () => {
    expect(quoteWindowsArg("plain")).toBe("plain");
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    // 结尾的反斜杠要加倍，否则会把收尾的引号转义掉
    expect(quoteWindowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(quoteWindowsArg('a\\"b c')).toBe('"a\\\\\\"b c"');
    expect(windowsCommandLineArgs(["a b", "c"])).toBe('"a b" c');
  });
});
