import { readFileSync, writeFileSync } from "node:fs";

/**
 * 「允许局域网设备访问」：桌面端内置 Server 默认只听 127.0.0.1。
 * 听 0.0.0.0 时 Windows 防火墙按 exe 路径问一次要不要放行，而 exe 在 app-<版本> 目录里，
 * 每升一版都要重新问；点了取消还会留下一条拦截规则，手机从此连不上。只在本机用的人用不着这些。
 */

export const LOOPBACK_HOST = "127.0.0.1";
export const LAN_HOST = "0.0.0.0";

export function hostFor(enabled: boolean): string {
  return enabled ? LAN_HOST : LOOPBACK_HOST;
}

/** 存下来的选择；没存过（升级前的版本、新装）是 undefined */
export function loadLanSetting(file: string): boolean | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown };
    return typeof value.enabled === "boolean" ? value.enabled : undefined;
  } catch {
    return undefined;
  }
}

export function saveLanSetting(file: string, enabled: boolean): void {
  try {
    writeFileSync(file, `${JSON.stringify({ enabled })}\n`);
  } catch {
    /* 存不下来：这次照常切换，下次启动按没存过处理 */
  }
}

/** Server 的 /api/local/lan-usage：有没有已登录的其它设备、还有效的访客会话 */
export type LanUsage = { ownerDevices: number; guestSessions: number };

/**
 * 升级前的版本一直听 0.0.0.0：已经有别的设备（扫码登录的手机、经飞书卡片登录的、接进来的访客和
 * 远程 Agent）连进来过的，升级后保持开启，别把人家的手机断掉。查不到（老 Server、出错）时也保持开启：
 * 宁可多弹一次防火墙，也不悄悄断掉别人的连接。
 */
export function legacyLanWanted(usage: LanUsage | undefined): boolean {
  if (!usage) return true;
  return usage.ownerDevices > 0 || usage.guestSessions > 0;
}

/** 给网页看的状态 */
export type LanAccessState = {
  enabled: boolean;
  /** 连的是别人起的 Server（hive start）时不由桌面端管，开关不显示 */
  managed: boolean;
  /** 正在换监听地址重启 Server */
  restarting: boolean;
};

/**
 * Windows 防火墙对这个 exe 的入站规则。只读检查，不加规则（按用户安装的没有管理员权限，
 * 也不该替用户改防火墙）。
 * - ok：当前网络类型上有启用的允许规则，也没有拦截
 * - blocked：有启用的拦截规则（拦截优先于允许）
 * - missing：没有允许规则，第一次有设备连进来时 Windows 会弹窗
 * - unknown：查不了（PowerShell 出错、被策略禁用）
 */
export type FirewallStatus = {
  status: "ok" | "blocked" | "missing" | "unknown";
  program: string;
};

/** PowerShell 里 NetFirewallRule 的枚举值（ConvertTo-Json 输出数字，不随系统语言变） */
const ACTION_ALLOW = 2;
const ACTION_BLOCK = 4;
const PROFILE_ANY = 0;
/** NetConnectionProfile.NetworkCategory：0 公用、1 专用、2 域 → 防火墙配置文件位 */
const CATEGORY_TO_PROFILE: Record<number, number> = { 0: 4, 1: 2, 2: 1 };

type RawRule = { Action?: unknown; Enabled?: unknown; Profile?: unknown };
type RawResult = { rules?: unknown; categories?: unknown };

/**
 * 查规则的 PowerShell 脚本：程序路径经环境变量传入，不拼进命令行（路径里有引号、空格也没事）。
 * 只取入站（Direction=1），输出 JSON：{ rules: [{Action,Enabled,Profile}], categories: [0|1|2] }。
 */
export const FIREWALL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  "$p=$env:SUPERHIVE_FIREWALL_PROGRAM",
  "$rules=@(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore | Where-Object { $_.Program -ieq $p } | Get-NetFirewallRule | Where-Object { $_.Direction -eq 1 } | ForEach-Object { @{ Action=[int]$_.Action; Enabled=[int]$_.Enabled; Profile=[int]$_.Profile } })",
  "$cats=@(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.NetworkCategory })",
  "ConvertTo-Json -Compress -Depth 3 @{ rules=$rules; categories=$cats }",
].join("; ");

function profileCovers(ruleProfile: number, profile: number): boolean {
  return ruleProfile === PROFILE_ANY || (ruleProfile & profile) !== 0;
}

/** 解析脚本输出。Enabled 在 PowerShell 里是 1=True、2=False */
export function parseFirewallResult(output: string, program: string): FirewallStatus {
  let parsed: RawResult;
  try {
    // 只认 JSON 那一行：PowerShell 偶尔会在前后打出别的东西（模块首次加载的进度）
    const line = output
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter((item) => item.startsWith("{"))
      .pop();
    parsed = JSON.parse(line ?? "") as RawResult;
  } catch {
    return { status: "unknown", program };
  }
  const asArray = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  const rules = asArray(parsed.rules)
    .map((rule) => rule as RawRule)
    .filter((rule) => Number(rule.Enabled) === 1)
    .map((rule) => ({ action: Number(rule.Action), profile: Number(rule.Profile) || 0 }));
  const categories = asArray(parsed.categories)
    .map((value) => CATEGORY_TO_PROFILE[Number(value)])
    .filter((value): value is number => value !== undefined);
  // 没连网络（拿不到当前网络类型）时按三种都算
  const profiles = categories.length ? [...new Set(categories)] : [1, 2, 4];
  const covered = (action: number, profile: number) =>
    rules.some((rule) => rule.action === action && profileCovers(rule.profile, profile));
  if (profiles.some((profile) => covered(ACTION_BLOCK, profile)))
    return { status: "blocked", program };
  if (profiles.every((profile) => covered(ACTION_ALLOW, profile))) return { status: "ok", program };
  return { status: "missing", program };
}

export type RunPowerShell = (script: string, env: Record<string, string>) => Promise<string>;

/** 只在 Windows 上查；其它平台返回 null（Mac 的「接受传入连接」没有能只读查询的接口） */
export async function checkFirewall(options: {
  platform: NodeJS.Platform;
  program: string;
  run: RunPowerShell;
}): Promise<FirewallStatus | null> {
  if (options.platform !== "win32") return null;
  try {
    const output = await options.run(FIREWALL_SCRIPT, {
      SUPERHIVE_FIREWALL_PROGRAM: options.program,
    });
    return parseFirewallResult(output, options.program);
  } catch {
    return { status: "unknown", program: options.program };
  }
}
