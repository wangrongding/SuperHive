/**
 * 拉起「父进程退出后还要继续活着」的后台常驻进程（Hive Server、本机 Agent），并且在 Windows 上不弹窗。
 * 与 apps/server/src/background-process.ts 相同（两个包分别发布，各带一份）。
 *
 * macOS / Linux：detached（自成进程组）+ 输出写日志文件，和以前一样。
 *
 * Windows 不能照搬 detached：它对应 DETACHED_PROCESS，进程根本没有控制台，
 * 之后它再拉起的每个控制台程序（node、git、claude、codex……）只要漏写 windowsHide，就会各自新开一个可见窗口
 * （Windows 11 默认交给 Windows Terminal，就是一层层纯黑的空窗口）。不 detached 又会被 libuv 放进
 * 「父进程退出即结束」的作业对象，Server 交接重启时 Agent 会被一起结束。
 * 所以 Windows 上先不 detached、带 windowsHide 起一个 PowerShell（得到一个看不见的控制台），
 * 再由它 Start-Process -NoNewWindow 拉起真正的进程：
 * - 真正的进程共用这个隐藏控制台，它再拉起的子进程默认也挂在上面，不会弹窗；
 * - libuv 的作业对象允许静默脱离，PowerShell 拉起的进程不在作业里，父进程退出后照样活着；
 * - 标准输出 / 错误沿用 PowerShell 拿到的日志文件句柄，日志照常写进文件。
 * PowerShell 把真正的 pid 写进一个临时文件后就退出，所以 Windows 上 pid 要异步拿到、退出要靠轮询发现。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type BackgroundOptions = {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** 标准输出和标准错误写到这个已打开的文件描述符；调用方在本函数返回后即可关闭 */
  logFd: number;
  /**
   * 只对 Windows 生效：在自己的隐藏控制台里运行（Start-Process -WindowStyle Hidden，走 ShellExecute），
   * 不继承父进程的任何句柄。默认的 -NoNewWindow 会把父进程继承来的管道句柄一并带给后台进程：
   * 从 ssh、或被 execFile 这类等管道关闭的调用方拉起时，调用方要一直等到后台进程退出才返回。
   * 代价是输出不进 logFd（新控制台看不见），由进程自己写日志。
   */
  windowsOwnConsole?: boolean | undefined;
};

export type BackgroundProcess = {
  /** 真正的进程 pid；拉起失败时 reject */
  pid: Promise<number>;
  /** macOS / Linux 上是子进程本身（可监听 exit 拿退出码）；Windows 上没有（已交给 PowerShell 拉起） */
  child?: ChildProcess | undefined;
};

/** 按 CommandLineToArgvW 的规则给一个参数加引号（与 libuv 拼命令行的做法一致） */
export function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      result += "\\".repeat(backslashes) + char;
    }
    backslashes = 0;
  }
  return `${result}${"\\".repeat(backslashes * 2)}"`;
}

export function windowsCommandLineArgs(args: readonly string[]): string {
  return args.map(quoteWindowsArg).join(" ");
}

/**
 * PowerShell 里执行的启动脚本。参数都从环境变量读，避免再拼一层 PowerShell 引号；
 * 读完先删掉这些变量，免得被真正的进程继承。
 */
export const WINDOWS_LAUNCH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$launch = @{ FilePath = $env:HIVE_BG_FILE; PassThru = $true }",
  "if ($env:HIVE_BG_OWN_CONSOLE) { $launch.WindowStyle = 'Hidden' } else { $launch.NoNewWindow = $true }",
  "if ($env:HIVE_BG_ARGS) { $launch.ArgumentList = $env:HIVE_BG_ARGS }",
  "if ($env:HIVE_BG_CWD) { $launch.WorkingDirectory = $env:HIVE_BG_CWD }",
  "$pidFile = $env:HIVE_BG_PID_FILE",
  "Remove-Item Env:HIVE_BG_FILE, Env:HIVE_BG_ARGS, Env:HIVE_BG_CWD, Env:HIVE_BG_PID_FILE, Env:HIVE_BG_OWN_CONSOLE -ErrorAction SilentlyContinue",
  "$p = Start-Process @launch",
  "[IO.File]::WriteAllText($pidFile, [string]$p.Id)",
].join("; ");

/** 系统自带的 Windows PowerShell 5.1；找不到时交给 PATH */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  if (root) {
    const candidate = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "powershell.exe";
}

export type BackgroundSpawn = typeof spawn;

export function spawnBackground(
  command: string,
  args: readonly string[],
  options: BackgroundOptions,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: BackgroundSpawn = spawn,
): BackgroundProcess {
  const stdio: ["ignore", number, number] = ["ignore", options.logFd, options.logFd];
  if (platform !== "win32") {
    const child = spawnImpl(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      // 自成进程组：父进程（及 dev 结束父进程组）退出时不会把它一起带走
      detached: true,
      stdio,
      windowsHide: true,
    });
    child.unref();
    const pid = new Promise<number>((resolve, reject) => {
      if (child.pid) resolve(child.pid);
      else child.once("error", reject);
    });
    pid.catch(() => undefined);
    return { pid, child };
  }

  const dir = mkdtempSync(path.join(tmpdir(), "hive-launch-"));
  const pidFile = path.join(dir, "pid");
  const env = options.env ?? process.env;
  const launcher = spawnImpl(
    windowsPowerShell(env),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_LAUNCH_SCRIPT],
    {
      env: {
        ...env,
        HIVE_BG_FILE: command,
        HIVE_BG_ARGS: windowsCommandLineArgs(args),
        HIVE_BG_CWD: options.cwd ?? "",
        HIVE_BG_PID_FILE: pidFile,
        ...(options.windowsOwnConsole ? { HIVE_BG_OWN_CONSOLE: "1" } : {}),
      },
      // 不 detached、带 windowsHide：PowerShell 得到一个看不见的控制台，真正的进程共用它
      detached: false,
      windowsHide: true,
      stdio,
    },
  );
  const pid = new Promise<number>((resolve, reject) => {
    const finish = (error?: Error) => {
      let value = Number.NaN;
      try {
        value = Number(readFileSync(pidFile, "utf8").trim());
      } catch {
        /* PowerShell 没写出 pid */
      }
      rmSync(dir, { recursive: true, force: true });
      if (Number.isInteger(value) && value > 0) resolve(value);
      else reject(error ?? new Error(`无法通过 PowerShell 启动 ${command}`));
    };
    launcher.once("error", (error) => finish(error));
    launcher.once("close", (code) =>
      finish(code === 0 ? undefined : new Error(`PowerShell 启动 ${command} 失败（exit ${code}）`)),
    );
  });
  pid.catch(() => undefined);
  return { pid };
}
