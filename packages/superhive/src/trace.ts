import { homedir } from "node:os";
import type { TraceStep } from "./hive-protocol.js";

/** 与 @superhive/protocol 的 LIMITS.maxTraceSummaryLength / maxTraceTextLength 保持一致 */
export const TRACE_SUMMARY_MAX = 300;
export const TRACE_TEXT_MAX = 2000;

const secretPatterns: Array<[RegExp, string]> = [
  // 常见的令牌前缀：OpenAI/Anthropic、GitHub、Slack、AWS、npm、Google
  [/\b(sk-(?:ant-)?[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/g, "$1…"],
  [/\b(gh[pousr]_)[A-Za-z0-9]{16,}/g, "$1…"],
  [/\b(github_pat_)[A-Za-z0-9_]{16,}/g, "$1…"],
  [/\b(xox[abprs]-)[A-Za-z0-9-]{10,}/g, "$1…"],
  [/\b(AKIA)[A-Z0-9]{12,}/g, "$1…"],
  [/\b(npm_)[A-Za-z0-9]{16,}/g, "$1…"],
  [/\b(AIza)[A-Za-z0-9_-]{20,}/g, "$1…"],
  // Authorization: Bearer xxx / Basic xxx
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  // KEY=value / KEY: value，键名里带 token/secret/password/key 之类
  [
    /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(\s*[=:]\s*|\s+)(["']?)[^\s"'&]{4,}\3/gi,
    "$1$2$3***$3",
  ],
  // URL 里的 user:password@
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, "$1***@"],
  // --token xxx / --password=xxx 这类参数
  [
    /(--?(?:token|password|passwd|secret|api-key|apikey|auth)(?:=|\s+))(["']?)[^\s"']+\2/gi,
    "$1$2***$2",
  ],
];

/** 执行过程会推到网页上：遮掉常见的密钥写法，家目录换成 ~ */
export function redactTrace(text: string, home = homedir()): string {
  let result = text;
  for (const [pattern, replacement] of secretPatterns)
    result = result.replace(pattern, replacement);
  if (home && home.length > 1) result = result.split(home).join("~");
  return result;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 一行摘要：多行命令只留第一行，并标出还有几行 */
export function traceSummary(value: string): string {
  const lines = value.trim().split(/\r?\n/);
  const first = lines[0]!.replace(/\s+/g, " ").trim();
  const more = lines.length > 1 ? ` …（共 ${lines.length} 行）` : "";
  return clip(redactTrace(first) + more, TRACE_SUMMARY_MAX);
}

export function traceText(value: string): string {
  return clip(redactTrace(value.trim()), TRACE_TEXT_MAX);
}

/** 上报前统一脱敏、截断；各 Runtime 的解析只管拿到原始字段 */
export function sanitizeTraceStep(step: TraceStep): TraceStep {
  const reported = { ...step };
  delete reported.hiveProgress;
  return {
    ...reported,
    id: step.id.slice(0, 120),
    ...(step.name ? { name: step.name.slice(0, 64) } : {}),
    ...(step.summary !== undefined ? { summary: traceSummary(step.summary) } : {}),
    ...(step.text !== undefined ? { text: traceText(step.text) } : {}),
  };
}

/** 每轮最多这么多段思考带正文；更早的只留时长，免得一轮几十段思考把执行过程撑满 */
export const THINKING_TEXT_STEPS_MAX = 20;
/** 同一段思考最快每秒更新一次正文 */
export const THINKING_THROTTLE_MS = 1_000;

/** 思考正文：先脱敏，超长时保留末尾（最新想到的），前面标「…」 */
export function thinkingText(value: string): string {
  const text = redactTrace(value.trim());
  return text.length > TRACE_TEXT_MAX ? `…${text.slice(-(TRACE_TEXT_MAX - 1))}` : text;
}

/**
 * 一轮里的思考步骤：各 Runtime 把思考片段交给它，累积成正文挂在 thinking 步骤上（同一个 id 原地更新）。
 * 正文更新按段节流；超过 THINKING_TEXT_STEPS_MAX 段时把最早一段的正文清空（text: ""）。
 */
export class ThinkingTrace {
  private readonly steps = new Map<
    string,
    {
      step: TraceStep;
      text: string;
      emittedAt: number;
      timer?: ReturnType<typeof setTimeout> | undefined;
      /** 超出段数上限被清掉了正文，之后也不再带正文 */
      dropped?: boolean;
    }
  >();
  /** 带过正文的段，按先后 */
  private readonly withText: string[] = [];

  constructor(
    private readonly emit: (step: TraceStep) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** 开始一段思考（已开始的不重复上报） */
  start(id: string): void {
    if (this.steps.has(id)) return;
    const step: TraceStep = {
      id,
      kind: "thinking",
      status: "running",
      startedAt: new Date(this.now()).toISOString(),
    };
    this.steps.set(id, { step, text: "", emittedAt: this.now() });
    this.emit(step);
  }

  /** 追加思考片段；距上次上报不到 1 秒的攒着，到点再报 */
  append(id: string, delta: string): void {
    if (!delta) return;
    this.start(id);
    const entry = this.steps.get(id)!;
    if (entry.step.status !== "running") return;
    entry.text += delta;
    // 只保留够用的末尾，避免很长的思考一直占内存
    if (entry.text.length > TRACE_TEXT_MAX * 4) entry.text = entry.text.slice(-TRACE_TEXT_MAX * 2);
    const wait = THINKING_THROTTLE_MS - (this.now() - entry.emittedAt);
    if (wait <= 0) {
      this.flush(id);
    } else if (!entry.timer) {
      entry.timer = setTimeout(() => this.flush(id), wait);
      entry.timer.unref?.();
    }
  }

  /** 结束一段思考；final 是 Runtime 最后给出的完整正文（有就以它为准） */
  end(id: string, final?: string): void {
    const entry = this.steps.get(id);
    if (!entry || entry.step.status !== "running") return;
    if (final?.trim()) entry.text = final;
    entry.step = { ...entry.step, status: "ok", endedAt: new Date(this.now()).toISOString() };
    this.flush(id);
  }

  /** 结束所有还在进行的思考（回合结束、被打断时） */
  endAll(): void {
    for (const id of this.steps.keys()) this.end(id);
  }

  private flush(id: string): void {
    const entry = this.steps.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.emittedAt = this.now();
    const text = !entry.dropped && entry.text.trim() ? thinkingText(entry.text) : "";
    if (text && !this.withText.includes(id)) {
      this.withText.push(id);
      while (this.withText.length > THINKING_TEXT_STEPS_MAX) {
        const dropped = this.steps.get(this.withText.shift()!);
        if (!dropped) continue;
        dropped.text = "";
        dropped.dropped = true;
        this.emit({ ...dropped.step, text: "" });
      }
    }
    this.emit(text ? { ...entry.step, text } : entry.step);
  }
}

/** 常见的只读命令（第一个词）；能执行别的命令或写文件的（find、sed、awk、env、sort、date……）不放进来 */
const readOnlyCommands = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "ls",
  "pwd",
  "echo",
  "wc",
  "grep",
  "rg",
  "ag",
  "stat",
  "file",
  "which",
  "whoami",
  "printenv",
  "du",
  "df",
  "ps",
  "cut",
  "diff",
  "jq",
  "nl",
  "true",
  "false",
  "printf",
  "test",
  "[",
  "type",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "tr",
  "sha256sum",
  "shasum",
  "md5",
  "od",
]);
/** 带什么参数都只读的 git 子命令；branch、remote 只认列出用法（见 readOnlyGitCommand） */
const readOnlyGit = new Set([
  "status",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
  "grep",
  "merge-base",
  "rev-list",
  "cat-file",
  "ls-tree",
  // 只更新远端跟踪分支，不碰工作区，重复执行也一样：建 worktree 前常先 fetch 一下基线
  "fetch",
  "ls-remote",
]);

/**
 * 去掉子命令前的全局选项：只认换目录、不分页这几种（`git -C <dir> status` 是看别的仓库最常见的写法）；
 * `-c`、`--exec-path` 等能改配置或调用外部程序的保留下来，交给后面按子命令判为不认识。
 */
function skipGitGlobalOptions(args: string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") i += 2;
    else if (/^--(?:git-dir|work-tree)=/.test(arg) || arg === "--no-pager" || arg === "-P") i += 1;
    else break;
  }
  return args.slice(i);
}

function readOnlyGitCommand(args: string[]): boolean {
  const [sub, ...rest] = skipGitGlobalOptions(args);
  if (!sub) return true;
  // 写文件或调用外部程序的参数：任何子命令带上都算改动
  if (
    rest.some((arg) =>
      /^(?:--output|-O|--open-files-in-pager|--ext-diff|--exec|-c\b|--config|--upload-pack)/.test(
        arg,
      ),
    )
  ) {
    return false;
  }
  if (sub === "diff") return true;
  if (sub === "worktree") return rest[0] === "list";
  // ls-remote 的 -u 等同 --upload-pack，会执行指定的程序
  if (sub === "ls-remote" && rest.some((arg) => /^-u/.test(arg))) return false;
  if (sub === "branch") {
    // git branch --list 后面跟的是匹配模式，不会建分支
    const listing = rest.includes("--list");
    return rest.every(
      (arg) =>
        (listing && !arg.startsWith("-")) ||
        /^(?:-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--verbose|--no-color|--contains|--merged|--no-merged)$/.test(
          arg,
        ),
    );
  }
  if (sub === "remote") return rest.every((arg) => arg === "-v" || arg === "--verbose");
  return readOnlyGit.has(sub);
}

type ShellParse = { segments: string[][]; unsafe: boolean };

/**
 * 按 POSIX shell 的引号规则把一行命令拆成若干段（按未加引号的 ; && || | & 换行 括号分开），每段是去掉引号的词。
 * 引号里的 | ; > 只是普通字符（比如 `rg 'a|b'`）；命令替换、进程替换、heredoc、写文件的重定向直接判为不安全。
 */
function parseShell(command: string): ShellParse {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  const unsafe = { segments, unsafe: true };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return unsafe;
      word += command.slice(i + 1, close);
      inWord = true;
      i = close;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j]!;
        // 双引号里命令替换照样会执行
        if (d === "`" || (d === "$" && command[j + 1] === "(")) return unsafe;
        if (d === "\\" && j + 1 < command.length) {
          word += command[++j];
          continue;
        }
        word += d;
      }
      if (j >= command.length) return unsafe;
      inWord = true;
      i = j;
    } else if (c === "\\") {
      if (command[i + 1] === "\n") i++;
      else if (i + 1 < command.length) {
        word += command[++i];
        inWord = true;
      }
    } else if (c === "`" || (c === "$" && command[i + 1] === "(")) {
      return unsafe;
    } else if (c === ">" || c === "<") {
      if (command[i + 1] === "(") return unsafe;
      if (c === "<") {
        // heredoc 的正文会被当成命令拆开，宁严勿松
        if (command[i + 1] === "<") return unsafe;
        endWord();
        continue;
      }
      // 只放过丢弃输出（>/dev/null）和合并文件描述符（2>&1）
      const fd = /^\d+$/.test(word) || word === "&" ? word : undefined;
      if (fd === undefined) endWord();
      else {
        word = "";
        inWord = false;
      }
      let j = i + 1;
      if (command[j] === ">") j++;
      if (command[j] === "&") {
        const dup = command.slice(j + 1).match(/^\d+|^-/);
        if (!dup) return unsafe;
        i = j + dup[0].length;
        continue;
      }
      while (command[j] === " " || command[j] === "\t") j++;
      if (!command.startsWith("/dev/null", j) || /[^\s;&|)]/.test(command[j + 9] ?? " "))
        return unsafe;
      i = j + 8;
    } else if (c === "&" && command[i + 1] === ">") {
      word = "&";
      inWord = true;
    } else if ("\n;|&()".includes(c)) {
      endSegment();
    } else if (c === " " || c === "\t") {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return { segments, unsafe: false };
}

/** Codex 常把命令包一层 `/bin/zsh -lc '…'`：剥掉这层再判断 */
function unwrapShell(command: string): string {
  const { segments, unsafe } = parseShell(command);
  const words = segments.length === 1 && !unsafe ? segments[0]! : [];
  if (
    words.length === 3 &&
    /^(?:\/\S*\/)?(?:ba|z)?sh$/.test(words[0]!) &&
    /^-l?c$|^-cl$/.test(words[1]!)
  ) {
    return words[2]!;
  }
  return command;
}

/** shell 关键字本身不执行东西，后面跟的才是命令 */
const shellKeywords = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "{",
  "}",
]);
const shellEnds = new Set(["fi", "done", "}"]);

/** sed 只认按行号打印（`sed -n '10,20p' f`），脚本里的 w/e/r 能写文件或执行命令 */
function readOnlySed(args: string[]): boolean {
  let script: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-e") script = (script ?? "") + (args[++i] ?? "x");
    else if (/^-[nEr]+$/.test(arg) || arg === "--quiet") continue;
    else if (arg.startsWith("-")) return false;
    else if (script === undefined) script = arg;
  }
  return script !== undefined && /^[\d\s,$;p]+$/.test(script);
}

function readOnlyFind(args: string[]): boolean {
  return !args.some((arg) =>
    /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg),
  );
}

function readOnlySegment(segment: string[]): boolean {
  const words = [...segment];
  // 环境变量前缀会改变命令行为（GIT_EXTERNAL_DIFF、PAGER……）：只放过语言、颜色这类无害的
  while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    if (!/^(?:LANG|LANGUAGE|LC_[A-Z]+|NO_COLOR|TERM|COLUMNS)=/.test(words[0])) return false;
    words.shift();
  }
  while (words[0] && shellKeywords.has(words[0])) words.shift();
  const [head, ...args] = words;
  if (!head || head === "cd" || shellEnds.has(head)) return true;
  // for x in a b c：后面只是数据
  if (head === "for") return args[1] === "in" || args.length === 1;
  if (head === "git") return readOnlyGitCommand(args);
  // rg --pre 会对每个文件执行指定的程序
  if (head === "rg") return !args.some((arg) => arg.startsWith("--pre"));
  if (head === "sed") return readOnlySed(args);
  if (head === "find") return readOnlyFind(args);
  // command -v / type 只是查命令在哪；command foo 会真的执行 foo
  if (head === "command") return args[0] === "-v" || args[0] === "-V";
  if (head === "sort") return !args.some((arg) => /^(?:-o|--output)/.test(arg));
  if (head === "date") return !args.some((arg) => /^(?:-s|--set)/.test(arg));
  return readOnlyCommands.has(head);
}

/** 只读命令：每一段都在白名单里，且没有命令替换、写文件的重定向、后台执行 */
export function readOnlyCommand(raw: string): boolean {
  const { segments, unsafe } = parseShell(unwrapShell(raw));
  return !unsafe && segments.every(readOnlySegment);
}

/** 不改东西的 Hive 工具（按工具名判断，不看参数正文） */
const readOnlyHiveTools = new Set([
  "hive_room_read",
  "hive_members_list",
  "hive_board_read",
  "hive_todo_list",
  "hive_attachment_read",
  "hive_schedule_list",
  "hive_wait",
  "hive_worktree_list",
]);

function hiveToolName(name: string): string {
  return name.replace(/^mcp__hive__/, "").replace(/^hive\./, "");
}

export function isHiveProgress(name: string, input: unknown): boolean {
  if (hiveToolName(name) !== "hive_message_send") return false;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return false;
    }
  }
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    (input as Record<string, unknown>).progress === true
  );
}

export function isHandoffSafeStep(step: TraceStep): boolean {
  if (!isMutatingStep(step)) return true;
  if (step.tool !== "collaboration") return false;
  const name = hiveToolName(step.name ?? "");
  return (
    name === "hive_worktree_create" ||
    name === "hive_board_update" ||
    (name === "hive_message_send" && step.hiveProgress === true)
  );
}

/**
 * 做过就撤不回、重做一遍会重复生效的对外操作：推代码、发包、部署、数据库迁移、往外发消息或写请求。
 * 只用来决定「中断时这一步正在跑、不知道做没做完」要不要先问人，不决定成败
 */
export function isIrreversibleStep(step: TraceStep): boolean {
  if (step.kind !== "tool") return false;
  // 非命令类工具（MCP 等）：名字里带 send / post / publish / create 的一律按撤不回处理
  if (step.tool !== "command") {
    const name = (step.name ?? "").replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
    // hive_message_send 带幂等键，重复调用不会多发
    if (/hive_message_send$/.test(step.name ?? "")) return false;
    return /send|post|publish|create|invoke|ask_human|deploy/i.test(name);
  }
  const text = step.summary ?? "";
  return [
    // git push：全局选项（-C、-c、--no-pager、--git-dir…）夹在中间也认
    /\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?|-P))*\s+push\b/,
    /\b(?:npm|pnpm|yarn|bun|changeset)\b[^|;&]*\bpublish\b/,
    /\bdocker\s+push\b|\bvercel\b[^|;&]*--prod\b|\bdeploy\b/,
    /\bmigrat(?:e|ion)\b/,
    /\b(?:kubectl|terraform|helm)\s+(?:apply|upgrade|install|destroy|delete)\b/,
    // curl 带请求体或非 GET 方法
    /\bcurl\b[^|;&]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)|\s--request\s+(?:POST|PUT|PATCH|DELETE)|\s(?:-d|-F|--data[\w-]*|--form|--json)\b)/i,
    /\bgh\s+(?:(?:pr|release|issue)\s+(?:create|merge|edit|close)|api\b[^|;&]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE))/i,
    /messages?[-_+]send|send[-_]message/,
  ].some((pattern) => pattern.test(text));
}

/**
 * 这一步可能有副作用吗（改文件、跑不明命令、发消息、调用外部工具……）？
 * 上游出错中断后，只有一步都没有副作用的回合才自动接着继续；判断宁严勿松，认不出的一律算有副作用。
 */
export function isMutatingStep(step: TraceStep): boolean {
  if (step.kind !== "tool") return false;
  switch (step.tool) {
    case "read":
    case "search":
      return false;
    case "command":
      return !readOnlyCommand(step.summary ?? "");
    case "collaboration": {
      const tool = hiveToolName(step.name ?? "");
      return !readOnlyHiveTools.has(tool);
    }
    default:
      return true;
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** Claude Code 工具调用的一行摘要：命令、文件路径、搜索词…… */
export function claudeToolSummary(name: string, input: Record<string, unknown>): string {
  const pick =
    str(input.command) ??
    str(input.file_path) ??
    str(input.notebook_path) ??
    str(input.pattern) ??
    str(input.query) ??
    str(input.url) ??
    str(input.path) ??
    str(input.description) ??
    str(input.prompt);
  if (name === "Grep" && str(input.pattern)) {
    return `${input.pattern}${str(input.path) ? `  in ${input.path}` : ""}`;
  }
  if (name.startsWith("mcp__")) {
    const [, server, tool] = name.split("__");
    // Hive 自己的工具不必再带服务名
    const label = server === "hive" ? tool! : `${server}.${tool}`;
    return pick ? `${label}  ${pick}` : label;
  }
  return pick ?? "";
}
