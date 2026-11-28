/**
 * hive telemetry status|on|off|preview|reset：查看和改匿名使用统计。
 * 开关和数据在 ~/.superhive/telemetry（同一台电脑上的 Server、桌面端共用），Server 没在跑也能改；
 * 跑着的 Server 下次用到时按文件重新读，不用重启。CLI 自己从不往外发，只往本机队列里追加，由 Server 统一上报。
 */
import {
  TELEMETRY_DOCS_URL,
  appendTelemetryEvents,
  hourOf,
  readTelemetryQueue,
  readTelemetryState,
  resetTelemetryId,
  setTelemetryEnabled,
  telemetryBlocker,
  telemetryContext,
  telemetryDir,
  telemetryEndpoint,
  telemetryRequestBody,
  telemetryRunMode,
  telemetrySite,
  type TelemetryBlocker,
  type TelemetryEventName,
  type TelemetryRunMode,
} from "./telemetry-core.js";

const BLOCKER_TEXT: Record<TelemetryBlocker, string> = {
  env: "设置了环境变量 SUPERHIVE_TELEMETRY=0",
  do_not_track: "设置了环境变量 DO_NOT_TRACK",
  ci: "在 CI 环境里运行",
  sandbox: "在沙箱预览里运行",
  test: "在测试环境里运行",
};

const usage = `用法：
  hive telemetry status   查看匿名使用统计开着没有、为什么
  hive telemetry on       打开
  hive telemetry off      关闭，并删掉还没发出的数据
  hive telemetry preview  打印下一次要发送的数据（发给统计服务的原始 JSON）
  hive telemetry reset    换一个新的随机安装 ID，并删掉还没发出的数据

也可以设环境变量 SUPERHIVE_TELEMETRY=0 或 DO_NOT_TRACK=1 一律关闭。
说明：${TELEMETRY_DOCS_URL}`;

export type TelemetryCommandOptions = {
  env?: NodeJS.ProcessEnv;
  dir?: string;
  /** 这份 superhive 的运行方式，决定用不用内置上报地址；默认按代码所在位置认 */
  runMode?: TelemetryRunMode;
  write?: (text: string) => void;
};

export function telemetryStatusText(
  env: NodeJS.ProcessEnv,
  dir: string,
  runMode: TelemetryRunMode = telemetryRunMode(import.meta.dirname, env),
): string {
  const blocker = telemetryBlocker(env);
  const { state, stored } = readTelemetryState(dir);
  const enabled = state.enabled !== false;
  const lines: string[] = [];
  if (blocker) {
    lines.push(`匿名使用统计：关（${BLOCKER_TEXT[blocker]}）`);
    if (!enabled) lines.push("另外你也选了关闭。");
  } else if (!enabled) {
    lines.push("匿名使用统计：关（你选了关闭，打开用 hive telemetry on）");
  } else {
    const endpoint = telemetryEndpoint(env, runMode);
    lines.push(
      endpoint
        ? "匿名使用统计：开"
        : env.SUPERHIVE_TELEMETRY_URL?.trim()
          ? "匿名使用统计：开（SUPERHIVE_TELEMETRY_URL 不是 http(s) 地址：只在本机记录，一条都不发）"
          : "匿名使用统计：开（源码运行默认不上报：只在本机记录，一条都不发；要发设 SUPERHIVE_TELEMETRY_URL）",
    );
    if (endpoint)
      lines.push(`  上报到：${endpoint.replace(/\/api\/batch$/, "")}（自部署的 Umami）`);
    lines.push(
      `  等着发的数据：${readTelemetryQueue(dir).length} 条（hive telemetry preview 查看）`,
    );
    lines.push("  关闭：hive telemetry off，或设环境变量 SUPERHIVE_TELEMETRY=0");
  }
  if (stored)
    lines.push(`  安装 ID：${state.installId}（随机生成，hive telemetry reset 可换一个）`);
  lines.push(`  收什么、不收什么：${TELEMETRY_DOCS_URL}`);
  return lines.join("\n");
}

export function telemetryCommand(args: string[], options: TelemetryCommandOptions = {}): void {
  const env = options.env ?? process.env;
  const dir = options.dir ?? telemetryDir(env);
  const write = options.write ?? ((text: string) => console.log(text));
  const sub = args[0] ?? "status";
  if (sub === "--help" || sub === "-h" || sub === "help") {
    write(usage);
    return;
  }
  if (sub === "status") {
    write(telemetryStatusText(env, dir, options.runMode));
    return;
  }
  if (sub === "on" || sub === "off") {
    setTelemetryEnabled(dir, sub === "on");
    write(
      sub === "on"
        ? "已打开匿名使用统计。收什么、不收什么见：" + TELEMETRY_DOCS_URL
        : "已关闭匿名使用统计，还没发出的数据也已删掉。",
    );
    const blocker = telemetryBlocker(env);
    if (sub === "on" && blocker) write(`不过现在${BLOCKER_TEXT[blocker]}，这时仍然一律不记。`);
    return;
  }
  if (sub === "preview") {
    const blocker = telemetryBlocker(env);
    const { state, stored } = readTelemetryState(dir);
    if (blocker || state.enabled === false || !stored) {
      write(
        blocker
          ? `匿名使用统计没在记录（${BLOCKER_TEXT[blocker]}），没有要发送的数据。`
          : state.enabled === false
            ? "匿名使用统计已关闭，没有要发送的数据。"
            : "还没有要发送的数据。",
      );
      return;
    }
    const queue = readTelemetryQueue(dir);
    write(
      queue.length
        ? JSON.stringify(telemetryRequestBody(telemetrySite(env), state.installId, queue), null, 2)
        : "还没有要发送的数据。",
    );
    return;
  }
  if (sub === "reset") {
    const state = resetTelemetryId(dir);
    write(`已换成新的安装 ID：${state.installId}，还没发出的数据也已删掉。`);
    return;
  }
  throw new Error(`未知的子命令：“telemetry ${sub}”。\n${usage}`);
}

/**
 * CLI 自己记一条事件（比如网页里点的 npm 更新，由 web-update 子进程完成）：只追加到本机队列，由 Server 统一发。
 * 没开、被挡住时什么都不做；出任何错都吞掉，不影响命令本身。
 */
export function recordCliTelemetry(
  event: TelemetryEventName,
  props: Record<string, unknown>,
  options: { version: string; env?: NodeJS.ProcessEnv; dir?: string; now?: number },
): void {
  try {
    const env = options.env ?? process.env;
    if (telemetryBlocker(env)) return;
    const dir = options.dir ?? telemetryDir(env);
    const { state, stored } = readTelemetryState(dir);
    if (!stored || state.enabled === false) return;
    appendTelemetryEvents(dir, [
      {
        event,
        time: hourOf(options.now ?? Date.now()),
        context: telemetryContext({
          version: options.version,
          runMode: "npm",
          locale: state.uiLocale,
        }),
        props,
      },
    ]);
  } catch {
    // 统计出错不影响更新
  }
}
