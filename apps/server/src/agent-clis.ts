import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  serverText,
  zhText,
  type AgentCliAction,
  type AgentCliInfo,
  type AgentCliInstallation,
  type AgentCliJob,
  type AgentCliSource,
  type AgentCliTool,
  type AgentCliUpdatePlan,
  type ServerText,
} from "@superhive/protocol";
import { HiveError } from "./database.js";
import { slowOps } from "./slow-ops.js";
import { findWindowsCommand, resolveCommand } from "./windows-command.js";

/**
 * 本机装了哪些 Agent CLI、版本、从哪装的，以及一键升级。做法参考 cc-switch
 * （commands/tool_version.rs、tool_discovery.rs、tool_lifecycle_command.rs、tool_node_requirement.rs）：
 * - 检测：用登录 shell 的 PATH（Server 若由 GUI / 后台进程拉起，PATH 很窄，看不到 nvm、Homebrew），
 *   再兜底扫常见安装目录；同一工具装了多处时按真实路径去重，各跑一次 `--version`。
 * - 来源：按入口路径和真实路径推断（nvm、Homebrew、volta、bun、pnpm、npm 全局前缀、官方安装器……）。
 * - 升级：命令锚定到命令行实际用的那一处（登录 shell PATH 里排第一的那处），用绝对路径加引号；
 *   认不出来源的不执行，提示用原来的方式升级。新版要求的 Node 本机不满足时不给升级。
 * - 执行：全局一次只跑一个；进度只留最近一行（节流、截断），失败给输出末几行。
 * 工具名只来自 TOOLS 白名单，命令里拼进去的只有白名单里的包名和探测到的绝对路径。
 */

type ToolSpec = {
  name: string;
  /** npm 包名（查最新版、npm 安装升级用）；不在 npm 上发布的（agy）没有，最新版查不到、只用官方脚本 */
  package?: string;
  /** 工具自带的升级子命令 */
  officialUpdate?: string;
  /** 优先用自带的升级子命令（cc-switch 的 prefers_official_update）；Codex 的 update 断网时会假成功，不用 */
  prefersOfficial?: boolean;
  /** npm i -g 时追加的参数：放行包自己的 postinstall 与平台 optional 依赖 */
  npmArgs?: string;
};

export const TOOLS: Record<AgentCliTool, ToolSpec> = {
  claude: {
    name: "Claude Code",
    package: "@anthropic-ai/claude-code",
    officialUpdate: "update",
    prefersOfficial: true,
    npmArgs: " --ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code",
  },
  codex: { name: "Codex", package: "@openai/codex", officialUpdate: "update" },
  copilot: { name: "GitHub Copilot CLI", package: "@github/copilot" },
  opencode: {
    name: "OpenCode",
    package: "opencode-ai",
    officialUpdate: "upgrade",
    prefersOfficial: true,
    npmArgs: " --ignore-scripts=false --include=optional --allow-scripts=opencode-ai",
  },
  // omp 的 npm 包入口是 bun 脚本：只有 bun 能装出能跑的 omp；`omp update` 自己认得安装渠道
  omp: {
    name: "Oh My Pi",
    package: "@oh-my-pi/pi-coding-agent",
    officialUpdate: "update",
    prefersOfficial: true,
  },
  openclaw: {
    name: "OpenClaw",
    package: "openclaw",
    officialUpdate: "update --yes",
    prefersOfficial: true,
  },
  gemini: { name: "Gemini CLI", package: "@google/gemini-cli" },
  // agy 不在 npm 上：官方脚本装单个原生程序到 ~/.local/bin，`agy update` 自升级
  agy: { name: "Antigravity CLI", officialUpdate: "update", prefersOfficial: true },
};

export const AGENT_CLI_TOOLS = Object.keys(TOOLS) as AgentCliTool[];

/**
 * 官方安装脚本（cc-switch 的 *_INSTALL_UNIX）：地址写死在这里，不拼任何外部输入。
 * 一律先下载到临时文件再交给 shell 执行，不用 `curl | sh`：curl 失败时整条命令稳定失败，
 * 不会把读到的空脚本当成成功。binDir 是脚本默认把命令放进的目录（相对家目录），装前提示 PATH 用。
 */
export const OFFICIAL_INSTALLERS = {
  claude: { url: "https://claude.ai/install.sh", shell: "bash", binDir: ".local/bin" },
  opencode: { url: "https://opencode.ai/install", shell: "bash", binDir: ".opencode/bin" },
  omp: { url: "https://omp.sh/install", shell: "sh", binDir: ".local/bin" },
  // 只用于升级独立安装版：它的 `codex update` 内部是 `curl | sh`，断网时也打印成功并 exit 0
  codex: { url: "https://chatgpt.com/codex/install.sh", shell: "sh", binDir: ".local/bin" },
  agy: { url: "https://antigravity.google/cli/install.sh", shell: "bash", binDir: ".local/bin" },
} as const satisfies Partial<
  Record<AgentCliTool, { url: string; shell: "bash" | "sh"; binDir: string }>
>;

export function installerCommand(tool: keyof typeof OFFICIAL_INSTALLERS): string {
  const { url, shell } = OFFICIAL_INSTALLERS[tool];
  // 比 cc-switch 多一步：下载到的必须是脚本（以 #! 开头）才执行。被墙、被重定向时这些地址可能返回
  // 200 的 HTML 页面（本机实测 claude.ai/install.sh 就是），交给 bash 会把 <、> 当重定向乱建文件
  return `bash -c 'tmp=$(mktemp) && curl -fsSL ${url} -o $tmp && head -c 2 $tmp | grep -q "#!" && ${shell} $tmp; status=$?; rm -f $tmp; exit $status'`;
}

/** 这些工具新装时先跑官方脚本：claude、opencode 失败再退回 npm，omp、agy 只用官方脚本 */
const SCRIPT_FIRST_INSTALL: ReadonlySet<AgentCliTool> = new Set([
  "claude",
  "opencode",
  "omp",
  "agy",
]);

const VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const DETECT_CACHE_MS = 60_000;
const LATEST_CACHE_MS = 10 * 60_000;
const LOGIN_PATH_CACHE_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const LOGIN_SHELL_TIMEOUT_MS = 8_000;
const REGISTRY_TIMEOUT_MS = 8_000;
const UPGRADE_TIMEOUT_MS = 15 * 60_000;
const PROGRESS_MAX = 200;
const PROGRESS_THROTTLE_MS = 150;
const ERROR_TAIL_LINES = 8;
const PROBE_ERROR_LINES = 4;
const KNOWN_SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh"]);

/* ---------------- 纯函数：路径与来源、版本、命令 ---------------- */

const lower = (value: string) => value.replace(/\\/g, "/").toLowerCase();

/** POSIX 单引号：整段包起来，内部的 ' 写成 '\'' */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 能拼进命令的路径：绝对路径，没有换行和 NUL */
function safePath(value: string): boolean {
  return path.posix.isAbsolute(value) && !/[\0\n\r]/.test(value);
}

/** npm 全局前缀放命令的目录：Windows 直接放在前缀里，其余平台在 bin/ */
export function prefixBin(prefix: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.win32.join(prefix) : path.posix.join(prefix, "bin");
}

/** file 在不在 dir 里（Windows 不分大小写、认两种斜杠） */
export function isInside(file: string, dir: string, platform: NodeJS.Platform): boolean {
  const norm = (value: string) =>
    platform === "win32" ? lower(value).replace(/\/+$/, "") : value.replace(/\/+$/, "");
  const base = norm(dir);
  return Boolean(base) && norm(file).startsWith(`${base}/`);
}

/**
 * Windows 上用自带 npm 装到 prefix 的命令，交给 `cmd.exe /d /s /c` 跑：node.exe 直接跑 npm-cli.js。
 * 路径里有 cmd 会改写的字符（" % ! ^）或换行就不拼，退回手动。
 */
export function windowsNpmInstall(bundled: BundledNpm, spec: ToolSpec): string | undefined {
  const paths = [bundled.node, bundled.npmCli, bundled.prefix];
  if (
    !spec.package ||
    paths.some((item) => /["%!^\0\r\n]/.test(item) || !path.win32.isAbsolute(item))
  ) {
    return undefined;
  }
  const quote = (value: string) => `"${value}"`;
  return `${quote(bundled.node)} ${quote(bundled.npmCli)} i -g --prefix ${quote(bundled.prefix)} ${spec.package}@latest${spec.npmArgs ?? ""}`;
}

/** 环境变量里换掉 PATH；Windows 上先去掉 Path、path 等别的大小写写法，免得子进程里两个都在 */
export function withPath(
  env: NodeJS.ProcessEnv,
  value: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return { ...env, PATH: value };
  const next: NodeJS.ProcessEnv = {};
  for (const [key, item] of Object.entries(env)) if (key.toLowerCase() !== "path") next[key] = item;
  next.Path = value;
  return next;
}

/**
 * 由入口路径（launcher，命令行看到的那个）和真实路径（real）推断安装来源。
 * Homebrew 看真实路径（Intel Cask 入口在 /usr/local/bin）；node 版本管理器看入口（shim 在入口路径上）。
 */
export function inferSource(launcher: string, real: string): AgentCliSource {
  const l = lower(launcher);
  const r = lower(real);
  if (r.includes("/cellar/") || r.includes("/caskroom/")) return "homebrew";
  if (r.startsWith("/nix/store/")) return "unknown";
  if (l.includes("/.nvm/")) return "nvm";
  if (l.includes("/.volta/") || l.includes("/volta/")) return "volta";
  if (l.includes("fnm_multishells") || l.includes("/fnm/")) return "fnm";
  if (l.includes("/mise/")) return "mise";
  if (l.includes("/.bun/")) return "bun";
  if (l.includes("/pnpm/")) return "pnpm";
  // Homebrew 的 node 装的 npm 全局包：/opt/homebrew/bin/x → /opt/homebrew/lib/node_modules/…
  if (l.includes("/homebrew/")) return "homebrew";
  if (r.includes("/.local/share/claude/") || r.includes("/claude/versions/")) return "native";
  if (r.includes("/packages/standalone/")) return "native";
  // agy 官方脚本放到 ~/.local/bin 的单个原生程序（不是指向 node_modules 的软链）
  if (/\/\.local\/bin\/agy(?:\.exe)?$/.test(r)) return "native";
  if (r.includes("/lib/node_modules/")) return "npm";
  return "unknown";
}

/** /opt/homebrew/Cellar/<formula>/… 或 /opt/homebrew/Caskroom/<cask>/… 里的名字 */
export function brewToken(real: string, marker: "Cellar" | "Caskroom"): string | undefined {
  const segments = real.split("/");
  const index = segments.findIndex((segment) => segment.toLowerCase() === marker.toLowerCase());
  const token = index >= 0 ? segments[index + 1] : undefined;
  return token && /^[\w@.+-]+$/.test(token) ? token : undefined;
}

/** 解析 x.y.z[-pre]；认不出时为 undefined */
export function parseVersion(
  value: string,
): { core: [number, number, number]; pre: string[] } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

/** a 比 b 新返回正数；认不出返回 undefined。预发布版比同号正式版旧 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return undefined;
  for (let i = 0; i < 3; i++) {
    const diff = left.core[i]! - right.core[i]!;
    if (diff) return Math.sign(diff);
  }
  if (!left.pre.length || !right.pre.length) return Math.sign(right.pre.length - left.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : undefined;
    const ny = /^\d+$/.test(y) ? Number(y) : undefined;
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return Math.sign(nx - ny);
    } else if (x !== y) {
      if (nx !== undefined) return -1;
      if (ny !== undefined) return 1;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

type Core = [number, number, number];
type Bound = { op: ">=" | ">" | "<=" | "<"; v: Core };

function coreCompare(a: Core, b: Core): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/** "18"、"18.2"、"18.x"、"*" → 已给出的数字段；x/* 截断 */
function partial(raw: string): number[] | undefined {
  if (raw === "" || raw === "*" || raw.toLowerCase() === "x") return [];
  const parts: number[] = [];
  for (const piece of raw.replace(/^v/, "").split(".")) {
    if (piece === "*" || piece.toLowerCase() === "x") break;
    if (!/^\d+$/.test(piece)) return undefined;
    parts.push(Number(piece));
  }
  return parts.length <= 3 ? parts : undefined;
}

const pad = (parts: number[]): Core => [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];

/** 部分版本号的上界（不含）：18 → 19.0.0，18.2 → 18.3.0 */
function bump(parts: number[]): Core | undefined {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return [parts[0]! + 1, 0, 0];
  if (parts.length === 2) return [parts[0]!, parts[1]! + 1, 0];
  return [parts[0]!, parts[1]!, parts[2]! + 1];
}

function comparator(token: string): Bound[] | undefined {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.*)$/.exec(token);
  if (!match) return undefined;
  const op = match[1] ?? "=";
  const parts = partial((match[2] ?? "").replace(/-.*$/, ""));
  if (!parts) return undefined;
  if (parts.length === 0) return op === "<" || op === ">" ? undefined : [];
  const v = pad(parts);
  switch (op) {
    case ">=":
      return [{ op: ">=", v }];
    case ">":
      return parts.length === 3 ? [{ op: ">", v }] : [{ op: ">=", v: bump(parts)! }];
    case "<":
      return [{ op: "<", v }];
    case "<=":
      return parts.length === 3 ? [{ op: "<=", v }] : [{ op: "<", v: bump(parts)! }];
    case "=":
      return parts.length === 3
        ? [
            { op: ">=", v },
            { op: "<=", v },
          ]
        : [
            { op: ">=", v },
            { op: "<", v: bump(parts)! },
          ];
    case "~":
      return [
        { op: ">=", v },
        { op: "<", v: parts.length === 1 ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0] },
      ];
    case "^": {
      const upper: Core =
        v[0] > 0 || parts.length === 1
          ? [v[0] + 1, 0, 0]
          : v[1] > 0 || parts.length === 2
            ? [0, v[1] + 1, 0]
            : [0, 0, v[2] + 1];
      return [
        { op: ">=", v },
        { op: "<", v: upper },
      ];
    }
  }
  return undefined;
}

/**
 * Node 版本 `version` 满不满足 npm 版本范围 `range`（engines.node）。
 * 支持比较符、^、~、x 通配、`a - b` 和 `||`；认不出的写法返回 undefined，调用方按「不确定」放行。
 */
export function nodeRangeSatisfied(range: string, version: string): boolean | undefined {
  const parsed = parseVersion(version);
  if (!parsed) return undefined;
  const v = parsed.core;
  let anyUnknown = false;
  for (const set of range.split("||")) {
    const text = set.trim();
    let bounds: Bound[] | undefined = [];
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) {
      const low = comparator(`>=${hyphen[1]}`);
      const high = comparator(`<=${hyphen[2]}`);
      bounds = low && high ? [...low, ...high] : undefined;
    } else if (text) {
      for (const token of text.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/)) {
        const next = comparator(token);
        if (!next) {
          bounds = undefined;
          break;
        }
        bounds.push(...next);
      }
    }
    if (!bounds) {
      anyUnknown = true;
      continue;
    }
    const ok = bounds.every((bound) => {
      const diff = coreCompare(v, bound.v);
      return bound.op === ">="
        ? diff >= 0
        : bound.op === ">"
          ? diff > 0
          : bound.op === "<="
            ? diff <= 0
            : diff < 0;
    });
    if (ok) return true;
  }
  return anyUnknown ? undefined : false;
}

/**
 * 桌面端自带的 Node 和 npm（环境变量 SUPERHIVE_BUNDLED_NODE / SUPERHIVE_AGENT_CLIS_DIR，见 apps/desktop/src/bundled-node.ts）。
 * 用它装的 CLI 一律装进 prefix（<userData>/agent-clis）：不用管理员权限，也不写进安装包或系统目录。
 */
export type BundledNpm = {
  node: string;
  /** bin/npm（Mac / Linux 上的 `#!/usr/bin/env node` 脚本） */
  npm: string;
  /** npm-cli.js：Windows 上用 node.exe 直接跑它，不经 npm.cmd */
  npmCli: string;
  prefix: string;
};

export type PlanContext = {
  platform: NodeJS.Platform;
  /** 文件是否存在且可执行 */
  isExecutable: (file: string) => boolean;
  bundled?: BundledNpm | undefined;
  /** 登录 shell PATH 里的 npm（自定义前缀的 npm 全局安装用它，配 --prefix 写回原处） */
  npm?: string | undefined;
};

type PackageCommand = { command: string } | { missing: string } | undefined;

function manual(text: ServerText, url?: string): AgentCliUpdatePlan {
  return { kind: "manual", reason: zhText(text), reasonText: text, ...(url ? { url } : {}) };
}

function packageCommand(
  tool: AgentCliTool,
  bin: string,
  real: string,
  source: AgentCliSource,
  context: PlanContext,
): PackageCommand {
  const spec = TOOLS[tool];
  const dir = path.posix.dirname(bin);
  const sibling = (name: string): PackageCommand | string => {
    const file = path.posix.join(dir, name);
    return context.isExecutable(file) ? file : { missing: name };
  };
  if (tool === "omp" && source !== "bun") return undefined;
  const pkg = spec.package;
  if (!pkg) return undefined;
  const npmArgs = spec.npmArgs ?? "";
  switch (source) {
    case "volta": {
      const volta = sibling("volta");
      return typeof volta === "string" ? { command: `${shellQuote(volta)} install ${pkg}` } : volta;
    }
    case "bun": {
      const bun = sibling("bun");
      return typeof bun === "string" ? { command: `${shellQuote(bun)} add -g ${pkg}@latest` } : bun;
    }
    case "pnpm": {
      const pnpm = sibling("pnpm");
      return typeof pnpm === "string"
        ? { command: `${shellQuote(pnpm)} add -g ${pkg}@latest` }
        : pnpm;
    }
    case "nvm":
    case "fnm":
    case "mise":
    case "homebrew": {
      // npm 是 `#!/usr/bin/env node` 脚本：把同目录放到 PATH 最前，用的就是这一处的 node
      const npm = sibling("npm");
      return typeof npm === "string"
        ? {
            command: `PATH=${shellQuote(dir)}:"$PATH" ${shellQuote(npm)} i -g ${pkg}@latest${npmArgs}`,
          }
        : npm;
    }
    case "npm": {
      const index = lower(real).lastIndexOf("/lib/node_modules/");
      const prefix = index > 0 ? real.slice(0, index) : undefined;
      if (!prefix || !safePath(prefix)) return undefined;
      if (!context.npm) return { missing: "npm" };
      return {
        command: `${shellQuote(context.npm)} i -g --prefix ${shellQuote(prefix)} ${pkg}@latest${npmArgs}`,
      };
    }
    default:
      return undefined;
  }
}

/**
 * 升级命令锚定到 `install` 那一处（cc-switch 的 anchored_command_from_paths）：
 * ① 官方安装器装的（Claude 原生、Codex 独立安装）→ 用那一处自己的升级方式；
 * ② Homebrew formula / cask → 同目录的 brew upgrade；
 * ③ 优先自升级的工具 → `<绝对路径> update || <锚定的包管理器命令>`；
 * ④ 其余 → 锚定到那一处的包管理器（nvm 等用同目录 npm，自定义前缀的 npm 全局用 --prefix）；
 * 认不出来源、或找不到同目录的包管理器 → 不执行，提示用原来的方式升级。
 */
export function planUpdate(
  tool: AgentCliTool,
  install: Pick<AgentCliInstallation, "path" | "realPath" | "source">,
  context: PlanContext,
): AgentCliUpdatePlan {
  if (context.platform === "win32") {
    // 只有用自带 npm 装进 agent-clis 的那份能一键升级：同一个 npm、同一个前缀再装一次 latest
    const command =
      context.bundled && tool !== "omp" && isInside(install.path, context.bundled.prefix, "win32")
        ? windowsNpmInstall(context.bundled, TOOLS[tool])
        : undefined;
    return command ? { kind: "anchored", command } : manual(serverText("agentCli.manual.windows"));
  }
  const spec = TOOLS[tool];
  const bin = install.path;
  const real = install.realPath;
  const unknown = () => manual(serverText("agentCli.manual.unknownSource", { path: bin }));
  if (!safePath(bin) || !safePath(real)) return unknown();
  const r = lower(real);
  const official = spec.officialUpdate ? `${shellQuote(bin)} ${spec.officialUpdate}` : undefined;

  if (tool === "claude" && install.source === "native" && official) {
    return { kind: "anchored", command: official };
  }
  if (tool === "codex") {
    const index = r.indexOf("/packages/standalone/");
    if (index > 0) {
      const home = real.slice(0, index);
      return {
        kind: "anchored",
        command: `CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR=${shellQuote(path.posix.dirname(bin))} CODEX_HOME=${shellQuote(home)} ${installerCommand("codex")}`,
      };
    }
  }
  if (r.startsWith("/nix/store/")) return manual(serverText("agentCli.manual.nix"));

  const cask = brewToken(real, "Caskroom");
  const formula = cask ? undefined : brewToken(real, "Cellar");
  if (cask || formula) {
    const brew = path.posix.join(path.posix.dirname(bin), "brew");
    if (!context.isExecutable(brew)) {
      return manual(serverText("agentCli.manual.noManager", { path: bin, manager: "brew" }));
    }
    return {
      kind: "anchored",
      command: cask
        ? `${shellQuote(brew)} upgrade --cask ${cask}`
        : `${shellQuote(brew)} upgrade ${formula}`,
    };
  }

  const fallback = packageCommand(tool, bin, real, install.source, context);
  if (spec.prefersOfficial && official) {
    // npm 装的 Claude / OpenCode 自升级时内部再调 npm：放行这个包的 postinstall 和平台依赖
    const scripts =
      (tool === "claude" || (tool === "opencode" && !r.includes("/.bun/"))) &&
      r.includes(`/node_modules/${spec.package}/`)
        ? `npm_config_allow_scripts=${spec.package} npm_config_ignore_scripts=false npm_config_include=optional `
        : "";
    const update = `${scripts}${official}`;
    // omp、agy：自带的 update 失败就重跑官方脚本（cc-switch 的 `omp update || <installer>`）
    const chained =
      tool === "omp" || tool === "agy"
        ? installerCommand(tool)
        : fallback && "command" in fallback
          ? fallback.command
          : undefined;
    return { kind: "anchored", command: chained ? `${update} || ${chained}` : update };
  }
  if (fallback && "command" in fallback) return { kind: "anchored", command: fallback.command };
  if (fallback && "missing" in fallback) {
    return manual(
      serverText("agentCli.manual.noManager", { path: bin, manager: fallback.missing }),
    );
  }
  return unknown();
}

export type InstallContext = {
  platform: NodeJS.Platform;
  isExecutable: (file: string) => boolean;
  /** 登录 shell PATH 里的 npm（绝对路径）；系统里没有 npm 时是桌面端自带的那个 */
  npm?: string | undefined;
  bundled?: BundledNpm | undefined;
};

/**
 * 没装的工具怎么装（cc-switch 的 posix_install_command_for）：
 * - claude、opencode：先跑官方安装脚本，失败再用 `||` 退回 npm；没有 npm 就只跑脚本；
 * - omp：只跑官方脚本（它有 bun 时用 bun 装，没有就下载校验预编译程序），不要求本机先有 bun；
 * - agy：不在 npm 上，只跑官方脚本；
 * - codex、copilot、openclaw、gemini：npm。
 * npm 用登录 shell PATH 里实际的那个（绝对路径），同目录有 node 时把这个目录放到 PATH 最前。
 * 系统里没有 npm、用的是桌面端自带的 npm 时，加 --prefix 装进 <userData>/agent-clis。
 * Windows：只有桌面端（自带 npm）能一键装 npm 上的工具，装进 agent-clis；omp、agy 仍要手动。
 */
export function planInstall(tool: AgentCliTool, context: InstallContext): AgentCliUpdatePlan {
  const spec = TOOLS[tool];
  if (context.platform === "win32") {
    const command =
      context.bundled && tool !== "omp" ? windowsNpmInstall(context.bundled, spec) : undefined;
    return command ? { kind: "anchored", command } : manual(serverText("agentCli.manual.windows"));
  }
  let npm: string | undefined;
  if (spec.package && context.npm && safePath(context.npm)) {
    const dir = path.posix.dirname(context.npm);
    const pathPrefix = context.isExecutable(path.posix.join(dir, "node"))
      ? `PATH=${shellQuote(dir)}:"$PATH" `
      : "";
    const prefix =
      context.bundled && context.npm === context.bundled.npm && safePath(context.bundled.prefix)
        ? ` --prefix ${shellQuote(context.bundled.prefix)}`
        : "";
    npm = `${pathPrefix}${shellQuote(context.npm)} i -g${prefix} ${spec.package}@latest${spec.npmArgs ?? ""}`;
  }
  if (tool === "omp" || tool === "agy") {
    return { kind: "anchored", command: installerCommand(tool) };
  }
  if (tool === "claude" || tool === "opencode") {
    const script = installerCommand(tool);
    return { kind: "anchored", command: npm ? `${script} || ${npm}` : script };
  }
  if (!npm) return manual(serverText("agentCli.manual.noNode"));
  return { kind: "anchored", command: npm };
}

/** 多处安装是否算冲突：版本不同，或者有的能跑有的跑不起来；同版本装两份都能跑不打扰 */
export function isConflicting(installs: Pick<AgentCliInstallation, "version" | "runnable">[]) {
  if (installs.length < 2) return false;
  const versions = new Set(installs.map((install) => install.version));
  const runnable = installs.some((install) => install.runnable);
  const broken = installs.some((install) => !install.runnable);
  return versions.size > 1 || (runnable && broken);
}

/** 从 `/usr/bin/env` 的输出里取 PATH（值必须以 / 开头，跳过 rc 打印的杂讯） */
export function pathFromEnvOutput(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("PATH=") && line.slice(5).startsWith("/")) return line.slice(5);
  }
  return undefined;
}

/** 环境变量里的 PATH（Windows 上不分大小写，常写作 Path） */
function envPath(env: NodeJS.ProcessEnv): string | undefined {
  const key = Object.keys(env).find((item) => item.toLowerCase() === "path");
  return key ? env[key] : undefined;
}

/** 合并两段 PATH：primary 在前，extra 里没出现过的按序追加，丢掉空段和相对路径 */
export function mergePath(primary: string, extra: string, delimiter = ":"): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const segment of [...primary.split(delimiter), ...extra.split(delimiter)]) {
    if (!segment || seen.has(segment)) continue;
    if (delimiter === ":" && !segment.startsWith("/")) continue;
    seen.add(segment);
    merged.push(segment);
  }
  return merged.join(delimiter);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** 一段输出里最后一行有内容的文字（去掉颜色，截到 200 字） */
export function lastLine(text: string): string | undefined {
  const lines = text
    .replace(ANSI, "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.at(-1);
  return line === undefined
    ? undefined
    : line.length > PROGRESS_MAX
      ? `${line.slice(0, PROGRESS_MAX - 1)}…`
      : line;
}

function tailLines(text: string, count: number): string {
  return text
    .replace(ANSI, "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-count)
    .join("\n");
}

/* ---------------- 有副作用的部分：探测、查最新版、执行 ---------------- */

export type ProbeResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 超时被结束、或者没能启动：只说明这次没探到，不能证明装坏了 */
  failedToRun?: string;
};

export type RunProbe = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<ProbeResult>;

export type UpgradeChild = {
  onOutput(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null, error?: Error) => void): void;
  kill(): void;
};

export type SpawnUpgrade = (command: string, env: NodeJS.ProcessEnv) => UpgradeChild;

/** 跑一个命令拿输出：独立进程组（交互式 rc 不能抢终端），stdin 关掉，超时连同子进程一起结束 */
export const defaultRunProbe: RunProbe = (command, args, options) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, stdout, stderr, failedToRun: String(error) });
      return;
    }
    const timer = setTimeout(() => {
      killGroup(child.pid);
      finish({ code: null, stdout, stderr, failedToRun: "timeout" });
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < 64_000) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish({ code: null, stdout, stderr, failedToRun: error.code ?? error.message }),
    );
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });

function killGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      // cmd.exe 下面还有 node / npm：连同子进程树一起结束
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => process.kill(pid, signal));
    } else process.kill(-pid, signal);
  } catch {
    /* 已经退出 */
  }
}

/** 在 /bin/sh 里跑升级命令；独立进程组，结束时连同 npm 等子进程一起结束 */
export const defaultSpawnUpgrade: SpawnUpgrade = (command, env) => {
  // 在临时目录里跑：安装脚本出意外也不会在 Server 的工作目录里留下文件
  const child =
    process.platform === "win32"
      ? // Windows 只跑 windowsNpmInstall 拼好的命令（路径都已加引号、没有 cmd 会改写的字符）
        spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
          env,
          cwd: tmpdir(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn("/bin/sh", ["-c", command], {
          env,
          cwd: tmpdir(),
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          windowsHide: true,
        });
  const outputs: Array<(chunk: string) => void> = [];
  const exits: Array<(code: number | null, error?: Error) => void> = [];
  let exited = false;
  const exit = (code: number | null, error?: Error) => {
    if (exited) return;
    exited = true;
    for (const listener of exits) listener(code, error);
  };
  const emit = (chunk: string) => outputs.forEach((listener) => listener(chunk));
  child.stdout.setEncoding("utf8").on("data", emit);
  child.stderr.setEncoding("utf8").on("data", emit);
  child.on("error", (error) => exit(null, error));
  child.on("close", (code) => exit(code));
  return {
    onOutput: (listener) => void outputs.push(listener),
    onExit: (listener) => void exits.push(listener),
    kill: () => {
      killGroup(child.pid);
      setTimeout(() => killGroup(child.pid, "SIGKILL"), 5_000).unref();
    },
  };
};

const defaultFetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) return undefined;
  return response.json();
};

function defaultIsExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultRealpath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export type AgentCliManagerOptions = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 登录 shell 的 PATH；默认跑 `$SHELL -lic /usr/bin/env` 取 */
  loginPath?: () => Promise<string | undefined>;
  /** 除登录 PATH 外兜底扫描的目录；默认 nvm、volta、bun、Homebrew 等常见位置 */
  extraDirs?: string[];
  runProbe?: RunProbe;
  fetchJson?: (url: string) => Promise<unknown>;
  spawnUpgrade?: SpawnUpgrade;
  isExecutable?: (file: string) => boolean;
  realpath?: (file: string) => string;
  now?: () => number;
  upgradeTimeoutMs?: number;
  /** 桌面端自带的 node；默认读 SUPERHIVE_BUNDLED_NODE */
  bundledNode?: string | undefined;
  /** 用自带 npm 安装时的全局前缀；默认读 SUPERHIVE_AGENT_CLIS_DIR */
  agentClisDir?: string | undefined;
};

type Detected = {
  installations: AgentCliInstallation[];
  /** 命令行默认那处 */
  primary: AgentCliInstallation | undefined;
};

export class AgentCliManager {
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runProbe: RunProbe;
  private readonly fetchJson: (url: string) => Promise<unknown>;
  private readonly spawnUpgrade: SpawnUpgrade;
  private readonly isExecutable: (file: string) => boolean;
  private readonly realpath: (file: string) => string;
  private readonly now: () => number;
  private readonly upgradeTimeoutMs: number;
  private loginPathCache?: { at: number; value: Promise<string> };
  private detectCache?: { at: number; value: Promise<Record<AgentCliTool, Detected>> } | undefined;
  private readonly latestCache = new Map<string, { at: number; value: Promise<string | null> }>();
  private readonly jobs = new Map<string, AgentCliJob>();
  private running: AgentCliJob | undefined;

  constructor(private readonly options: AgentCliManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
    this.runProbe = options.runProbe ?? defaultRunProbe;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.spawnUpgrade = options.spawnUpgrade ?? defaultSpawnUpgrade;
    this.isExecutable = options.isExecutable ?? defaultIsExecutable;
    this.realpath = options.realpath ?? defaultRealpath;
    this.now = options.now ?? Date.now;
    this.upgradeTimeoutMs = options.upgradeTimeoutMs ?? UPGRADE_TIMEOUT_MS;
  }

  /** 登录 shell 的 PATH 合并本进程的 PATH（登录 shell 在前） */
  loginPath(): Promise<string> {
    const cached = this.loginPathCache;
    if (cached && this.now() - cached.at < LOGIN_PATH_CACHE_MS) return cached.value;
    const win = this.platform === "win32";
    const own = (win ? envPath(this.env) : this.env.PATH) ?? "";
    // 桌面端的 agent-clis 和自带 Node 排在最后：用户自己装的 node、CLI 优先
    const tail = this.bundledDirs().join(win ? ";" : ":");
    const withTail = (value: string) => (tail ? mergePath(value, tail, win ? ";" : ":") : value);
    const value = (this.options.loginPath ?? (() => this.readLoginPath()))().then(
      (login) => withTail(win ? own : mergePath(login ?? "", own || "/usr/bin:/bin")),
      () => withTail(own),
    );
    this.loginPathCache = { at: this.now(), value };
    return value;
  }

  private bundledNodePath(): string | undefined {
    const node = this.options.bundledNode ?? this.env.SUPERHIVE_BUNDLED_NODE;
    return node && path.isAbsolute(node) ? node : undefined;
  }

  private agentClisDir(): string | undefined {
    const dir = this.options.agentClisDir ?? this.env.SUPERHIVE_AGENT_CLIS_DIR;
    return dir && (this.platform === "win32" ? path.win32 : path.posix).isAbsolute(dir)
      ? dir
      : undefined;
  }

  /** 追加到 PATH 末尾的目录：agent-clis 的命令目录、自带 node 所在目录 */
  private bundledDirs(): string[] {
    const p = this.platform === "win32" ? path.win32 : path.posix;
    const prefix = this.agentClisDir();
    const node = this.bundledNodePath();
    return [
      ...(prefix ? [prefixBin(prefix, this.platform)] : []),
      ...(node ? [p.dirname(node)] : []),
    ];
  }

  /** 自带的 node、npm 都在、也知道往哪装，才算有自带 npm */
  private bundledNpm(): BundledNpm | undefined {
    const node = this.bundledNodePath();
    const prefix = this.agentClisDir();
    if (!node || !prefix || !this.isExecutable(node)) return undefined;
    const win = this.platform === "win32";
    const p = win ? path.win32 : path.posix;
    const dir = p.dirname(node);
    const npmCli = win
      ? p.join(dir, "node_modules", "npm", "bin", "npm-cli.js")
      : p.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    const npm = win ? p.join(dir, "npm.cmd") : p.join(dir, "npm");
    // Windows 上 X_OK 等同于文件存在
    if (!this.isExecutable(npmCli)) return undefined;
    return { node, npm, npmCli, prefix };
  }

  private readLoginPath(): Promise<string | undefined> {
    return slowOps.track("agentClis.loginShell", {}, () => this.probeLoginPath());
  }

  private async probeLoginPath(): Promise<string | undefined> {
    if (this.platform === "win32") return undefined;
    const configured = this.env.SHELL;
    const shell =
      configured &&
      path.isAbsolute(configured) &&
      KNOWN_SHELLS.has(path.basename(configured)) &&
      this.isExecutable(configured)
        ? configured
        : "/bin/sh";
    const name = path.basename(shell);
    // -i 才会读 .zshrc / .bashrc（nvm 多半在那里初始化）；sh、dash 只认 -l
    const flags = name === "sh" || name === "dash" ? ["-l", "-c"] : ["-l", "-i", "-c"];
    const result = await this.runProbe(shell, [...flags, "/usr/bin/env"], {
      env: this.env,
      timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
    });
    return pathFromEnvOutput(result.stdout);
  }

  /** 兜底扫描的目录：GUI 拉起的 Server 看不到登录 PATH 时，常见的安装位置也要找得到 */
  private extraDirs(): string[] {
    if (this.options.extraDirs) return this.options.extraDirs;
    const home = this.home;
    const nvm = path.join(home, ".nvm", "versions", "node");
    return [
      ...listDir(nvm).map((version) => path.join(nvm, version, "bin")),
      path.join(home, ".volta", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, "Library", "pnpm"),
      path.join(home, ".local", "share", "pnpm"),
      path.join(home, ".local", "share", "mise", "shims"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];
  }

  private async probeInstall(
    tool: AgentCliTool,
    file: string,
    real: string,
    loginPath: string,
    pathDefault: boolean,
  ): Promise<AgentCliInstallation> {
    const dir = path.dirname(file);
    const delimiter = this.platform === "win32" ? ";" : ":";
    // 同目录放到 PATH 最前：nvm 装的 CLI 是 `#!/usr/bin/env node` 脚本，要用同一处的 node
    const env = {
      ...withPath(this.env, `${dir}${delimiter}${loginPath}`, this.platform),
      NO_COLOR: "1",
    };
    let command = file;
    let args = ["--version"];
    if (this.platform === "win32") {
      try {
        const resolved = resolveCommand(file, { env });
        command = resolved.command;
        args = [...resolved.args, "--version"];
      } catch (error) {
        return {
          path: file,
          realPath: real,
          version: null,
          runnable: false,
          error: String(error),
          source: inferSource(file, real),
          pathDefault,
        };
      }
    }
    const result = await this.runProbe(command, args, { env, timeoutMs: PROBE_TIMEOUT_MS });
    const output = `${result.stdout}\n${result.stderr}`;
    const runnable = result.code === 0 && !result.failedToRun;
    const version = runnable ? (VERSION_RE.exec(output)?.[0] ?? null) : null;
    const error = runnable
      ? undefined
      : result.failedToRun === "timeout"
        ? "--version timed out"
        : tailLines(output, PROBE_ERROR_LINES) ||
          (result.failedToRun ?? `exit code ${String(result.code)}`);
    return {
      path: file,
      realPath: real,
      version,
      runnable,
      ...(error ? { error } : {}),
      source: inferSource(file, real),
      pathDefault,
    };
  }

  private detectTool(tool: AgentCliTool, loginPath: string): Promise<Detected> {
    return slowOps.track(`agentClis.detect ${tool}`, {}, () => this.findInstalls(tool, loginPath));
  }

  private async findInstalls(tool: AgentCliTool, loginPath: string): Promise<Detected> {
    if (this.platform === "win32") {
      const found = findWindowsCommand(tool, withPath(this.env, loginPath, "win32"));
      if (!found) return { installations: [], primary: undefined };
      const install = await this.probeInstall(tool, found, this.realpath(found), loginPath, true);
      return { installations: [install], primary: install };
    }
    const pathDirs = loginPath.split(":").filter((dir) => dir.startsWith("/"));
    const onPath = new Set(pathDirs);
    const seen = new Set<string>();
    const candidates: Array<{ file: string; real: string; pathDefault: boolean }> = [];
    let defaultTaken = false;
    for (const dir of [...pathDirs, ...this.extraDirs()]) {
      const file = path.join(dir, tool);
      if (!this.isExecutable(file)) continue;
      const real = this.realpath(file);
      const isDefault = !defaultTaken && onPath.has(dir);
      if (isDefault) defaultTaken = true;
      if (seen.has(real)) continue;
      seen.add(real);
      candidates.push({ file, real, pathDefault: isDefault });
    }
    const installations = await Promise.all(
      candidates.map((candidate) =>
        this.probeInstall(tool, candidate.file, candidate.real, loginPath, candidate.pathDefault),
      ),
    );
    return { installations, primary: installations.find((install) => install.pathDefault) };
  }

  private detectAll(refresh: boolean): Promise<Record<AgentCliTool, Detected>> {
    const cached = this.detectCache;
    if (!refresh && cached && this.now() - cached.at < DETECT_CACHE_MS) return cached.value;
    const value = this.loginPath().then(async (loginPath) => {
      const entries = await Promise.all(
        AGENT_CLI_TOOLS.map(
          async (tool) => [tool, await this.detectTool(tool, loginPath)] as const,
        ),
      );
      return Object.fromEntries(entries) as Record<AgentCliTool, Detected>;
    });
    this.detectCache = { at: this.now(), value };
    value.catch(() => {
      if (this.detectCache?.value === value) this.detectCache = undefined;
    });
    return value;
  }

  /** npm 上的最新版（dist-tags 的 latest）；查不到、不在 npm 上为 null */
  latest(tool: AgentCliTool, refresh = false): Promise<string | null> {
    const pkg = TOOLS[tool].package;
    if (!pkg) return Promise.resolve(null);
    const cached = this.latestCache.get(pkg);
    if (!refresh && cached && this.now() - cached.at < LATEST_CACHE_MS) return cached.value;
    const url = `https://registry.npmjs.org/-/package/${pkg.replace("/", "%2f")}/dist-tags`;
    const value = this.fetchJson(url).then(
      (json) => {
        const latest = (json as { latest?: unknown } | undefined)?.latest;
        return typeof latest === "string" && parseVersion(latest) ? latest : null;
      },
      () => null,
    );
    this.latestCache.set(pkg, { at: this.now(), value });
    return value;
  }

  /** 升级会用到的 node：只看由 node 运行的 npm 包（原生安装、Homebrew 管的、bun 装的都不看） */
  private nodeFor(install: AgentCliInstallation, loginPath: string): string | undefined {
    const real = lower(install.realPath);
    if (!real.includes("/node_modules/") || install.source === "bun") return undefined;
    if (brewToken(install.realPath, "Cellar") || brewToken(install.realPath, "Caskroom")) {
      return undefined;
    }
    const sibling = path.join(path.dirname(install.path), "node");
    return this.isExecutable(sibling) ? sibling : this.findOnPath("node", loginPath);
  }

  private async nodeVersion(node: string | undefined, loginPath: string) {
    if (!node) return undefined;
    const result = await this.runProbe(node, ["--version"], {
      env: { ...this.env, PATH: loginPath },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.code !== 0) return undefined;
    return VERSION_RE.exec(result.stdout)?.[0];
  }

  /** 新版的 engines.node 本机不满足时返回差距；认不出、查不到一律放行 */
  private async nodeGap(
    tool: AgentCliTool,
    node: string | undefined,
    latest: string,
    loginPath: string,
  ): Promise<{ required: string; current: string } | undefined> {
    const current = await this.nodeVersion(node, loginPath);
    if (!current) return undefined;
    const pkg = TOOLS[tool].package;
    if (!pkg) return undefined;
    const json = await this.fetchJson(
      `https://registry.npmjs.org/${pkg.replace("/", "%2f")}/${encodeURIComponent(latest)}`,
    ).catch(() => undefined);
    const required = (json as { engines?: { node?: unknown } } | undefined)?.engines?.node;
    if (typeof required !== "string" || !required.trim()) return undefined;
    return nodeRangeSatisfied(required.trim(), current) === false
      ? { required: required.trim(), current }
      : undefined;
  }

  private findOnPath(name: string, loginPath: string): string | undefined {
    for (const dir of loginPath.split(":")) {
      if (!dir.startsWith("/")) continue;
      const file = path.join(dir, name);
      if (this.isExecutable(file)) return file;
    }
    return undefined;
  }

  /**
   * 全局安装会把命令放进哪个目录：先跑官方脚本的看脚本默认目录（omp 的 PI_INSTALL_DIR 可改），
   * npm 用 `npm prefix -g`/bin
   */
  private async globalBin(tool: AgentCliTool, context: InstallContext, loginPath: string) {
    if (tool === "claude" || tool === "opencode" || tool === "omp" || tool === "agy") {
      const custom = tool === "omp" ? this.env.PI_INSTALL_DIR : undefined;
      return custom && path.isAbsolute(custom)
        ? custom
        : path.join(this.home, OFFICIAL_INSTALLERS[tool].binDir);
    }
    if (context.bundled && (this.platform === "win32" || context.npm === context.bundled.npm)) {
      return prefixBin(context.bundled.prefix, this.platform);
    }
    if (!context.npm) return undefined;
    const result = await this.runProbe(context.npm, ["prefix", "-g"], {
      env: { ...this.env, PATH: `${path.dirname(context.npm)}:${loginPath}` },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.code !== 0) return undefined;
    const prefix = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/"))
      .at(-1);
    return prefix ? path.join(prefix, "bin") : undefined;
  }

  private installContext(loginPath: string): InstallContext {
    const bundled = this.bundledNpm();
    return {
      platform: this.platform,
      isExecutable: this.isExecutable,
      npm: this.platform === "win32" ? undefined : this.findOnPath("npm", loginPath),
      bundled,
    };
  }

  private async installInfo(
    tool: AgentCliTool,
    base: AgentCliInfo,
    loginPath: string,
    refresh: boolean,
  ): Promise<AgentCliInfo> {
    const context = this.installContext(loginPath);
    const plan = planInstall(tool, context);
    if (plan.kind !== "anchored") return { ...base, plan };
    const latest = await this.latest(tool, refresh);
    // 先跑官方脚本的装的是原生程序，不看 Node；npm 装的用 npm 同目录的 node，没有就用 PATH 里的
    const node =
      this.platform === "win32"
        ? context.bundled?.node
        : SCRIPT_FIRST_INSTALL.has(tool) || !context.npm
          ? undefined
          : this.isExecutable(path.join(path.dirname(context.npm), "node"))
            ? path.join(path.dirname(context.npm), "node")
            : this.findOnPath("node", loginPath);
    const [nodeGap, bin] = await Promise.all([
      latest ? this.nodeGap(tool, node, latest, loginPath) : undefined,
      this.globalBin(tool, context, loginPath),
    ]);
    const onPath = new Set(loginPath.split(":"));
    return {
      ...base,
      latest,
      plan,
      ...(nodeGap ? { nodeGap } : {}),
      ...(bin && !onPath.has(bin) ? { binNotOnPath: bin } : {}),
    };
  }

  private planFor(tool: AgentCliTool, detected: Detected, loginPath: string): AgentCliUpdatePlan {
    if (!detected.primary) {
      return manual(serverText("agentCli.manual.notOnPath", { tool: TOOLS[tool].name }));
    }
    return planUpdate(tool, detected.primary, {
      platform: this.platform,
      isExecutable: this.isExecutable,
      npm: this.platform === "win32" ? undefined : this.findOnPath("npm", loginPath),
      bundled: this.bundledNpm(),
    });
  }

  private async info(
    tool: AgentCliTool,
    detected: Detected,
    loginPath: string,
    refresh: boolean,
  ): Promise<AgentCliInfo> {
    const spec = TOOLS[tool];
    const { installations, primary } = detected;
    const reference = primary ?? installations.find((install) => install.runnable);
    const status = !installations.length
      ? "notInstalled"
      : (primary ?? reference)?.runnable
        ? "ok"
        : "broken";
    const version = reference?.version ?? null;
    const base: AgentCliInfo = {
      tool,
      name: spec.name,
      package: spec.package ?? "",
      status,
      version,
      installations,
      conflict: isConflicting(installations),
      latest: null,
      updateAvailable: false,
    };
    if (status === "notInstalled") return this.installInfo(tool, base, loginPath, refresh);
    const latest = await this.latest(tool, refresh);
    const newer = latest && version ? (compareVersions(latest, version) ?? 0) > 0 : false;
    const updateAvailable = Boolean(latest) && (newer || status === "broken");
    const plan = this.planFor(tool, detected, loginPath);
    const nodeGap =
      updateAvailable && latest && primary && plan.kind === "anchored"
        ? await this.nodeGap(tool, this.nodeFor(primary, loginPath), latest, loginPath)
        : undefined;
    return {
      ...base,
      latest,
      updateAvailable,
      plan,
      ...(nodeGap ? { nodeGap } : {}),
    };
  }

  /** 各 CLI 的安装情况；refresh 时重新探测、重新查最新版 */
  async list(refresh = false): Promise<AgentCliInfo[]> {
    return slowOps.track("agentClis.list", {}, async () => {
      const [detected, loginPath] = await Promise.all([this.detectAll(refresh), this.loginPath()]);
      return Promise.all(
        AGENT_CLI_TOOLS.map((tool) => this.info(tool, detected[tool], loginPath, refresh)),
      );
    });
  }

  job(id: string): AgentCliJob | undefined {
    return this.jobs.get(id);
  }

  /** 正在跑（含还在核对命令）或最近一次的安装、升级 */
  current(): AgentCliJob | undefined {
    return this.running ?? [...this.jobs.values()].at(-1);
  }

  /**
   * 执行页面确认过的安装或升级：重新探测这一个工具、重新算命令，和确认的那条一字不差才执行。
   * 一次只跑一个；返回刚开始的任务，进度经 job(id) 取。
   */
  async start(tool: AgentCliTool, action: AgentCliAction, confirmed: string): Promise<AgentCliJob> {
    const spec = TOOLS[tool];
    if (this.running) {
      throw new HiveError(
        "AGENT_CLI_BUSY",
        serverText("error.agentCli.busy", { tool: TOOLS[this.running.tool].name }),
      );
    }
    // 先占住并登记，免得两个请求同时探测完都去执行；核对期间刷新页面也能看到它在进行
    const job: AgentCliJob = {
      id: randomUUID(),
      tool,
      action,
      command: confirmed,
      state: "running",
      progress: "",
      startedAt: new Date(this.now()).toISOString(),
    };
    this.running = job;
    this.jobs.set(job.id, job);
    try {
      const loginPath = await this.loginPath();
      const detected = await this.detectTool(tool, loginPath);
      const info = await this.info(tool, detected, loginPath, true);
      if (action === "install" && info.status !== "notInstalled") {
        throw new HiveError(
          "AGENT_CLI_ALREADY_INSTALLED",
          serverText("error.agentCli.alreadyInstalled", { tool: spec.name }),
        );
      }
      const plan = info.plan;
      if (
        !plan ||
        plan.kind !== "anchored" ||
        (action === "upgrade" && info.status === "notInstalled")
      ) {
        const reason =
          plan?.kind === "manual"
            ? plan.reason
            : zhText(serverText("agentCli.manual.notOnPath", { tool: spec.name }));
        throw new HiveError(
          action === "install" ? "AGENT_CLI_NOT_INSTALLABLE" : "AGENT_CLI_NOT_UPGRADABLE",
          serverText(
            action === "install" ? "error.agentCli.notInstallable" : "error.agentCli.notUpgradable",
            { tool: spec.name, reason },
          ),
        );
      }
      if (plan.command !== confirmed) {
        throw new HiveError(
          "AGENT_CLI_PLAN_CHANGED",
          serverText("error.agentCli.planChanged", { tool: spec.name }),
        );
      }
      if (action === "upgrade" && info.latest && !info.updateAvailable && info.version) {
        throw new HiveError(
          "AGENT_CLI_UP_TO_DATE",
          serverText("error.agentCli.upToDate", { tool: spec.name, version: info.version }),
        );
      }
      if (info.nodeGap && info.latest) {
        throw new HiveError(
          "AGENT_CLI_NODE_TOO_OLD",
          serverText("error.agentCli.nodeTooOld", {
            tool: spec.name,
            latest: info.latest,
            required: info.nodeGap.required,
            current: info.nodeGap.current,
          }),
        );
      }
      job.versionBefore = info.version;
      this.run(job, loginPath);
      return { ...job };
    } catch (error) {
      if (this.running === job) this.running = undefined;
      this.jobs.delete(job.id);
      throw error;
    }
  }

  /** 升级（start 的简写，保留给已有调用） */
  upgrade(tool: AgentCliTool, confirmed: string): Promise<AgentCliJob> {
    return this.start(tool, "upgrade", confirmed);
  }

  private run(job: AgentCliJob, loginPath: string) {
    let output = "";
    let pending: string | undefined;
    let lastPush = 0;
    let flush: ReturnType<typeof setTimeout> | undefined;
    const push = () => {
      flush = undefined;
      if (pending === undefined) return;
      job.progress = pending;
      pending = undefined;
      lastPush = this.now();
    };
    let child: UpgradeChild;
    let settled = false;
    const fail = (text: ServerText, tail: string) => {
      job.state = "failed";
      job.reason = zhText(text);
      job.reasonText = text;
      if (tail) job.error = tail;
      if (this.running === job) this.running = undefined;
    };
    const finish = (code: number | null, error?: Error | ServerText) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (flush) clearTimeout(flush);
      push();
      job.finishedAt = new Date(this.now()).toISOString();
      const tail = tailLines(output, ERROR_TAIL_LINES);
      if (code === 0 && !error) {
        this.detectCache = undefined;
        // 退出码 0 不算数：重新探测这一处的版本再定成败（自带升级命令断网、装到别处时也会 exit 0）。
        // 核对完之前任务仍算进行中，锁也不放
        void this.detectTool(job.tool, loginPath)
          .then(
            (detected) => {
              const found = detected.primary ?? detected.installations[0];
              return { after: found?.version ?? null, broken: Boolean(found && !found.runnable) };
            },
            () => ({ after: null, broken: false }),
          )
          .then(({ after, broken }) => {
            job.versionAfter = after;
            const name = TOOLS[job.tool].name;
            if (job.action === "install" && broken) {
              // npm 下载平台相关的可选依赖失败时只记一笔、照样退出 0（实测网络慢时 Claude Code 的原生程序包就这样丢了）
              fail(serverText("error.agentCli.installBroken", { tool: name }), tail);
            } else if (job.action === "upgrade" && after === null) {
              fail(serverText("error.agentCli.versionUnknown", { tool: name }), tail);
            } else if (
              job.action === "upgrade" &&
              after &&
              job.versionBefore &&
              (compareVersions(after, job.versionBefore) ??
                (after === job.versionBefore ? 0 : 1)) <= 0
            ) {
              fail(
                serverText("error.agentCli.versionUnchanged", { tool: name, version: after }),
                tail,
              );
            } else {
              job.state = "succeeded";
              if (this.running === job) this.running = undefined;
            }
          });
        return;
      }
      const text: ServerText =
        error && "key" in error
          ? error
          : error
            ? serverText("error.agentCli.spawnFailed", { reason: error.message })
            : serverText("error.agentCli.exitCode", { code: String(code) });
      fail(text, tail);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        null,
        serverText("error.agentCli.timeout", {
          minutes: Math.round(this.upgradeTimeoutMs / 60_000),
        }),
      );
    }, this.upgradeTimeoutMs);
    try {
      child = this.spawnUpgrade(job.command, {
        ...withPath(this.env, loginPath, this.platform),
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        npm_config_yes: "true",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      });
    } catch (error) {
      finish(null, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    child.onOutput((chunk) => {
      output = (output + chunk).slice(-16_000);
      const line = lastLine(chunk);
      if (line === undefined) return;
      pending = line;
      const wait = PROGRESS_THROTTLE_MS - (this.now() - lastPush);
      if (wait <= 0) push();
      else flush ??= setTimeout(push, wait);
    });
    child.onExit((code, error) => finish(code, error));
  }
}
