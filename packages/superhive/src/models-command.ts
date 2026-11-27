import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ACP_PROTOCOL_VERSION, sessionModelChoices } from "./acp-responder.js";
import {
  fetchClaudeModels,
  resolveClaudeApi,
  useEnvProxy,
  type ClaudeApi,
  type ClaudeApiOptions,
  type FetchLike,
} from "./claude-models.js";
import {
  fetchCodexModels,
  resolveCodexApi,
  resolveCodexConfig,
  type CodexConfig,
  type CodexConfigOptions,
} from "./codex-models.js";
import { geminiHomeEnv, hasGeminiApiKey } from "./gemini-client.js";
import { superhiveHome } from "./home-dir.js";
import { spawnStdioTransport } from "./stdio-transport.js";
import { commandFor } from "./windows-command.js";

const usage = `
用法：
  hive models --provider codex|claude|copilot|opencode|omp|openclaw|gemini|agy [--command PATH] [--cwd DIR] [--json]

列出这个 Agent CLI 能用的模型，供网页上选择模型、「换个模型重试」使用。
codex 走自定义网关（当前 provider 有 base_url）时按它实际生效的配置（--cwd 是 Agent 的工作目录，
项目里的 .codex/config.toml 会盖过全局配置）请求 {base_url}/models，拉不到或用官方接口、账号登录时用 app-server 的
model/list，配置里的 model 不在列表里也补在最前；opencode 用 opencode models，omp 用 omp models --json，
openclaw 用 openclaw models list --json，gemini、agy 经 ACP 开一个空会话读它给的模型；
claude 按它实际生效的接口地址和密钥（--cwd 是 Agent 的工作目录，项目配置会盖过全局配置）请求 /v1/models，
只列具体模型（opusplan 在最后）；用账号登录（没有 key）或拉取失败时给出常用别名；copilot 给出常用选项。网页上都能手填。
同时列出能选的思考强度（claude、codex、copilot、omp 支持；codex、omp 按模型列出）。
`;

export type ModelProvider =
  "codex" | "claude" | "copilot" | "opencode" | "omp" | "openclaw" | "gemini" | "agy";

export type ModelEntry = {
  /** 传给运行时的模型名（--model、turn/start 的 model、ACP 的 configOption 值） */
  id: string;
  /** 显示名（和 id 一样时不给） */
  label?: string;
  /** 一句说明（列表里没有对应具体模型的特殊选项，例如 Claude 的 opusplan） */
  description?: string;
  /** 运行时自己的默认模型 */
  isDefault?: boolean;
  /** 这个模型支持的思考强度（运行时按模型列出时才有：Codex、omp） */
  efforts?: string[];
  /** 这个模型默认的思考强度 */
  defaultEffort?: string;
};

export type ModelList = {
  provider: ModelProvider;
  /** runtime：从运行时拉到的；preset：运行时没有列模型的能力，给的常用选项 */
  source: "runtime" | "preset";
  models: ModelEntry[];
  /** 运行时接受的全部思考强度；空数组表示不支持按 Agent 切换（与 @superhive/protocol 的 RUNTIME_REASONING_EFFORTS 一致） */
  efforts: string[];
  /** 拉取失败的原因（这时 models 是常用选项） */
  error?: string;
  /** 为什么只给常用选项（不算失败）：oauth=Claude 用账号登录、没有 API key；cloud=走 Bedrock / Vertex 等云平台 */
  presetReason?: "oauth" | "cloud";
};

/** 跑一个命令拿标准输出（测试注入） */
export type ModelRunner = (command: string, args: string[]) => Promise<string>;
/** 和 Codex app-server 说一次 model/list（测试注入） */
export type CodexModelLister = (command: string) => Promise<unknown>;
/** 起 ACP Agent 开一个空会话，返回 session/new 的结果（测试注入） */
export type AcpModelLister = (provider: "gemini" | "agy", command: string) => Promise<unknown>;

const TIMEOUT_MS = 20_000;
const MAX_MODELS = 300;

/**
 * Claude 的 opusplan：计划模式用 opus 别名、其余时候用 sonnet 别名（走网关时按 ANTHROPIC_DEFAULT_OPUS_MODEL /
 * ANTHROPIC_DEFAULT_SONNET_MODEL 解析）。它是一种模式，接口列表里没有对应的具体模型，拉到完整列表时也保留，放在最后
 */
const CLAUDE_OPUSPLAN: ModelEntry = {
  id: "opusplan",
  label: "Opus Plan",
  description: "计划模式用 Opus、其余用 Sonnet；Hive 里只有只读 Agent 跑在计划模式",
};

/** 没有列模型命令（或拉不到）的运行时给的常用选项（别名由 CLI 自己解析到当前最新的版本） */
const PRESETS: Partial<Record<ModelProvider, ModelEntry[]>> = {
  claude: [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
    CLAUDE_OPUSPLAN,
  ],
  copilot: [{ id: "auto", label: "Auto（Copilot 自动选）" }],
};

/**
 * 各运行时 CLI 接受的思考强度（由低到高），与 @superhive/protocol 的 RUNTIME_REASONING_EFFORTS 一致：
 * claude --effort、copilot --reasoning-effort、codex turn/start 的 effort、omp ACP 的 thinking
 */
export const RUNTIME_EFFORTS: Partial<Record<ModelProvider, string[]>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  copilot: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  omp: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
};

const defaultRunner: ModelRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const target = commandFor(command, args);
    execFile(
      target.command,
      target.args,
      { timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/** 起一个 codex app-server，握手后调 model/list（分页取完），然后关掉 */
const defaultCodexLister: CodexModelLister = (command) =>
  new Promise((resolve, reject) => {
    const target = commandFor(command, ["app-server"]);
    const child = spawn(target.command, target.args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const data: unknown[] = [];
    let buffer = "";
    let nextId = 2;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve({ data });
    };
    const timer = setTimeout(
      () => finish(new Error("Codex app-server 没有在 20 秒内返回模型列表")),
      TIMEOUT_MS,
    );
    const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const list = (cursor?: string) =>
      write({ id: nextId++, method: "model/list", params: cursor ? { cursor } : {} });
    child.on("error", (error) => finish(error));
    child.on("exit", () => finish(new Error("Codex app-server 提前退出")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === undefined || message.method) continue;
        if (message.error) {
          finish(new Error(String(message.error.message ?? "model/list 失败")));
          return;
        }
        if (message.id === 1) {
          write({ method: "initialized" });
          list();
          continue;
        }
        if (Array.isArray(message.result?.data)) data.push(...message.result.data);
        const cursor = message.result?.nextCursor;
        if (typeof cursor === "string" && cursor && data.length < MAX_MODELS) list(cursor);
        else finish();
      }
    });
    write({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "superhive", title: "SuperHive", version: "0" } },
    });
  });

/**
 * gemini、agy 的模型只能从 ACP 会话里拿（agy models 要求登录 Google 账号）：握手、开一个不带 MCP 的空会话，
 * 读 configOptions / models 后结束进程。agy 没登录账号而环境里有 GEMINI_API_KEY 时先用它登录，与 Bridge 一致
 */
const defaultAcpLister: AcpModelLister = (provider, command) =>
  new Promise((resolve, reject) => {
    const env = geminiHomeEnv();
    const cwd = path.join(superhiveHome(), "models-probe");
    mkdirSync(cwd, { recursive: true });
    const args = provider === "gemini" ? ["--acp", "--skip-trust"] : ["acp"];
    const transport = spawnStdioTransport(command, args, {
      cwd,
      ...(Object.keys(env).length ? { env } : {}),
    });
    const pending = new Map<number, (message: any) => void>();
    let nextId = 1;
    let done = false;
    const finish = (error?: Error, result?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      transport.kill();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error(`${command} 没有在 20 秒内返回模型列表`)),
      TIMEOUT_MS,
    );
    const call = (method: string, params: unknown) =>
      new Promise<any>((done, fail) => {
        const id = nextId++;
        pending.set(id, (message) =>
          message.error
            ? fail(
                Object.assign(new Error(String(message.error.message ?? `${method} 失败`)), {
                  code: message.error.code,
                }),
              )
            : done(message.result),
        );
        transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    transport.onExit((exit) =>
      finish(exit.error ?? new Error(`${command} 提前退出：${exit.stderr.trim().slice(-300)}`)),
    );
    transport.onLine((line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.method !== undefined) {
        // 不支持客户端方法；通知（session/update）忽略
        if (message.id !== undefined)
          transport.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "unsupported" },
            }),
          );
        return;
      }
      const handle = pending.get(message?.id);
      if (!handle) return;
      pending.delete(message.id);
      handle(message);
    });
    void (async () => {
      const init = await call("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "superhive", title: "SuperHive", version: "0" },
      });
      const params = { cwd, mcpServers: [] };
      try {
        return await call("session/new", params);
      } catch (error) {
        const methods: Array<{ id?: unknown }> = Array.isArray(init?.authMethods)
          ? init.authMethods
          : [];
        const canUseKey =
          provider === "agy" &&
          (error as { code?: unknown }).code === -32000 &&
          hasGeminiApiKey(env) &&
          methods.some((method) => method?.id === "gemini-api-key");
        if (!canUseKey) throw error;
        await call("authenticate", { methodId: "gemini-api-key" });
        return await call("session/new", params);
      }
    })().then(
      (result) => finish(undefined, result),
      (error: Error) => finish(error),
    );
  });

/** ACP session/new 的结果：configOptions 的 model 或 models.availableModels */
function parseAcpSession(result: unknown): ModelEntry[] {
  const found = sessionModelChoices(result);
  if (!found) return [];
  const names = new Map<string, string>();
  const record = result as {
    configOptions?: Array<{ id?: unknown; category?: unknown; options?: unknown }>;
    models?: { availableModels?: Array<{ modelId?: unknown; name?: unknown }> };
  };
  if (found.via === "config") {
    const option = record.configOptions?.find(
      (item) => item?.id === "model" || item?.category === "model",
    );
    for (const item of Array.isArray(option?.options)
      ? (option.options as Array<{ value?: unknown; name?: unknown }>)
      : []) {
      const value = text(item?.value);
      const name = text(item?.name);
      if (value && name) names.set(value, name);
    }
  } else {
    for (const item of record.models?.availableModels ?? []) {
      const value = text(item?.modelId);
      const name = text(item?.name);
      if (value && name) names.set(value, name);
    }
  }
  return found.options.map((id) => entry(id, names.get(id), id === found.current));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function entry(id: string, label?: string, isDefault?: boolean): ModelEntry {
  return {
    id,
    ...(label && label !== id ? { label } : {}),
    ...(isDefault ? { isDefault: true } : {}),
  };
}

function withEfforts(model: ModelEntry, efforts: string[], defaultEffort?: string): ModelEntry {
  const list = [...new Set(efforts)];
  return {
    ...model,
    ...(list.length ? { efforts: list } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
  };
}

function unique(models: ModelEntry[]): ModelEntry[] {
  const seen = new Set<string>();
  return models.filter((model) => !seen.has(model.id) && seen.add(model.id)).slice(0, MAX_MODELS);
}

function parseCodex(result: unknown): ModelEntry[] {
  const data = Array.isArray((result as { data?: unknown })?.data)
    ? ((result as { data: unknown[] }).data as Record<string, unknown>[])
    : [];
  return data.flatMap((item) => {
    const id = text(item?.model) ?? text(item?.id);
    if (!id || item.hidden === true) return [];
    const efforts = (
      Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : []
    ).flatMap((option: { reasoningEffort?: unknown } | null) => {
      const effort = text(option?.reasoningEffort);
      return effort ? [effort] : [];
    });
    return [
      withEfforts(
        entry(id, text(item.displayName), item.isDefault === true),
        efforts,
        text(item.defaultReasoningEffort),
      ),
    ];
  });
}

/** opencode models：一行一个 provider/model */
function parseLines(stdout: string): ModelEntry[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[\w.@-]+\/[\w.:@/-]+$/.test(line))
    .map((line) => entry(line));
}

/** omp models --json：{ models: [{ selector, name }] } */
function parseOmp(stdout: string): ModelEntry[] {
  const models = (JSON.parse(stdout) as { models?: Record<string, unknown>[] }).models ?? [];
  return models.flatMap((item) => {
    const id = text(item?.selector) ?? text(item?.id);
    if (!id || (item.kind !== undefined && item.kind !== "chat")) return [];
    // omp 的会话里这一项是 off、auto 加上模型自己的档位；不能推理的模型只能 off
    const thinking = Array.isArray(item.thinking)
      ? item.thinking.filter((level): level is string => typeof level === "string")
      : [];
    const efforts = item.reasoning === false ? [] : ["off", ...thinking, "auto"];
    return [withEfforts(entry(id, text(item.name)), efforts)];
  });
}

/** openclaw models list --json：{ models: [{ key, name, available, tags }] } */
function parseOpenClaw(stdout: string): ModelEntry[] {
  const start = stdout.indexOf("{");
  const models =
    (
      JSON.parse(start >= 0 ? stdout.slice(start) : stdout) as {
        models?: Record<string, unknown>[];
      }
    ).models ?? [];
  return models.flatMap((item) => {
    const id = text(item?.key);
    if (!id || item.available === false) return [];
    const tags = Array.isArray(item.tags) ? item.tags : [];
    return [entry(id, text(item.name), tags.includes("default"))];
  });
}

/**
 * Claude Code 没指定模型时用的：ANTHROPIC_MODEL，其次 settings.json（CLAUDE_CONFIG_DIR 或 ~/.claude）里的 model；
 * 都没有就是账号默认，不知道是哪个
 */
export function claudeConfiguredModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.ANTHROPIC_MODEL?.trim();
  if (fromEnv) return fromEnv;
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  try {
    const settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")) as {
      model?: unknown;
    };
    return typeof settings.model === "string" && settings.model.trim()
      ? settings.model.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/** 文件读不到就是 undefined */
function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * OpenCode 的默认模型：OPENCODE_CONFIG 指的文件，其次 ~/.config/opencode/opencode.json(c) 顶层的 model。
 * 不引 JSONC 解析库：只认顶层（缩进不超过两格）那一行 "model": "…"
 */
export function opencodeConfiguredModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = path.join(
    env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"),
    "opencode",
  );
  const files = [
    env.OPENCODE_CONFIG?.trim(),
    path.join(dir, "opencode.json"),
    path.join(dir, "opencode.jsonc"),
  ];
  for (const file of files) {
    const text = file ? readText(file) : undefined;
    const match = text ? /^[ \t]{0,2}"model"\s*:\s*"([^"]+)"/m.exec(text) : null;
    if (match) return match[1]!.trim();
  }
  return undefined;
}

/** omp 的默认模型：~/.omp/agent/config.yml 里 modelRoles.default，去掉末尾的「:思考档」 */
export function ompConfiguredModel(home: string = os.homedir()): string | undefined {
  const text = readText(path.join(home, ".omp", "agent", "config.yml"));
  const match = text
    ? /^modelRoles:\s*\n(?:[ \t]+.*\n)*?[ \t]+default:\s*["']?([^"'\s#]+)/m.exec(text)
    : null;
  return match ? match[1]!.replace(/:[a-z]+$/i, "") : undefined;
}

/** 各运行时自己配置的默认模型（没指定模型时 CLI 用它）；不知道返回 undefined */
export function configuredDefaultModel(provider: ModelProvider): string | undefined {
  if (provider === "claude") return claudeConfiguredModel();
  if (provider === "opencode") return opencodeConfiguredModel();
  if (provider === "omp") return ompConfiguredModel();
  return undefined;
}

/** 把运行时自己的默认模型标出来：在列表里就标上，不在就加在最前面 */
function withDefault(models: ModelEntry[], id: string | undefined): ModelEntry[] {
  if (!id) return models;
  if (models.some((model) => model.id === id)) {
    return models.map((model) => (model.id === id ? { ...model, isDefault: true } : model));
  }
  return [{ id, isDefault: true }, ...models];
}

export async function listModels(options: {
  provider: ModelProvider;
  command?: string;
  run?: ModelRunner;
  listCodex?: CodexModelLister;
  listAcp?: AcpModelLister;
  /** 运行时自己配置的默认模型（测试注入）；默认读各 CLI 的配置文件 */
  configuredDefault?: (provider: ModelProvider) => string | undefined;
  /** Agent 的工作目录：Claude 的项目级配置会盖过全局配置 */
  cwd?: string;
  /** 算出 Claude 实际用的接口和密钥（测试注入） */
  claudeApi?: (options: ClaudeApiOptions) => Promise<ClaudeApi>;
  /** 请求 Claude 的 /v1/models、Codex 网关的 /models（测试注入） */
  fetch?: FetchLike;
  /** 合出 Codex 当前生效的 model 和 provider（测试注入） */
  codexConfig?: (options: CodexConfigOptions) => CodexConfig;
}): Promise<ModelList> {
  const { provider } = options;
  const command = options.command ?? provider;
  const run = options.run ?? defaultRunner;
  const efforts = RUNTIME_EFFORTS[provider] ?? [];
  const preset = PRESETS[provider];
  const fallback = () => (options.configuredDefault ?? configuredDefaultModel)(provider);
  if (provider === "claude") return listClaude(options, efforts, fallback);
  if (provider === "codex") return listCodex(options, efforts);
  if (preset)
    return { provider, source: "preset", models: withDefault(preset, fallback()), efforts };
  try {
    let models: ModelEntry[];
    if (provider === "opencode") models = parseLines(await run(command, ["models"]));
    else if (provider === "omp") models = parseOmp(await run(command, ["models", "--json"]));
    else if (provider === "gemini" || provider === "agy")
      models = parseAcpSession(await (options.listAcp ?? defaultAcpLister)(provider, command));
    else models = parseOpenClaw(await run(command, ["models", "list", "--json"]));
    models = unique(models);
    // 运行时列表里没标默认的，按它自己的配置文件标上
    if (!models.some((model) => model.isDefault)) models = withDefault(models, fallback());
    return { provider, source: "runtime", models, efforts };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      provider,
      source: "preset",
      models: [],
      efforts,
      error: reason.replace(/\s+/g, " ").slice(0, 300),
    };
  }
}

function errorText(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.replace(/\s+/g, " ").slice(0, 300);
}

/**
 * Claude：用它实际生效的接口地址和密钥拉 /v1/models。拉到了就只列具体模型（按名字排），配置的默认模型不在
 * 列表里时补在最前，opusplan 放最后；opus、sonnet、haiku 这几个别名不再列（指向哪个具体模型取决于 Claude Code
 * 的版本和 ANTHROPIC_DEFAULT_*_MODEL，不如直接选具体模型清楚）。用账号登录、走云平台或拉取失败时只能给别名，
 * 并说明原因
 */
async function listClaude(
  options: Parameters<typeof listModels>[0],
  efforts: string[],
  fallback: () => string | undefined,
): Promise<ModelList> {
  const aliases = PRESETS.claude!;
  const preset = (extra: Pick<ModelList, "error" | "presetReason">): ModelList => ({
    provider: "claude",
    source: "preset",
    models: withDefault(aliases, fallback()),
    efforts,
    ...extra,
  });
  try {
    const api = await (options.claudeApi ?? resolveClaudeApi)({
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    if (api.kind !== "key") return preset({ presetReason: api.kind });
    proxyFetch(options);
    const fetched = await fetchClaudeModels(api, options.fetch);
    const configured = fallback();
    // 按模型名排序：网关返回的顺序每次不一样，排好后列表稳定，`hive models` 和网页看到的一致
    const listed = fetched
      .map((model) => entry(model.id, model.label))
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    // 配置的默认模型不在列表里（例如带 [1M] 后缀，或是 opus 这样的别名）：补在最前
    const missing =
      configured &&
      configured !== CLAUDE_OPUSPLAN.id &&
      !listed.some((model) => model.id === configured)
        ? [{ id: configured }]
        : [];
    // opusplan 始终在最后（网关自己也列了的话也挪到最后）
    const models = unique([
      ...missing,
      ...listed.filter((model) => model.id !== CLAUDE_OPUSPLAN.id),
      CLAUDE_OPUSPLAN,
    ]);
    return {
      provider: "claude",
      source: "runtime",
      models: withDefault(models, configured),
      efforts,
    };
  } catch (error) {
    return preset({ error: errorText(error) });
  }
}

/** 设了 HTTPS_PROXY 等代理时让 fetch 走代理（测试注入 fetch 时不动全局） */
function proxyFetch(options: Parameters<typeof listModels>[0]): void {
  if (!options.fetch)
    useEnvProxy(
      process.env,
      (http as { setGlobalProxyFromEnv?: (env: NodeJS.ProcessEnv) => unknown })
        .setGlobalProxyFromEnv,
    );
}

/** 配置里的 model 就是 Codex 实际用的默认：标上它（不在列表里就补在最前），其他的不再标默认 */
function withCodexDefault(models: ModelEntry[], id: string | undefined): ModelEntry[] {
  if (!id) return models;
  const plain = models.map((model) => {
    const copy = { ...model };
    delete copy.isDefault;
    return copy;
  });
  return withDefault(plain, id);
}

/**
 * Codex：当前 provider 是自定义网关时请求 {base_url}/models，拉到了就用网关列表（按名字排；思考强度从
 * model/list 里同名的模型拿，没有就用通用的那几档），配置的 model 不在列表里补在最前。官方 openai、要账号登录、
 * 认证方式不支持时用 model/list；网关拉取失败也退回 model/list 并说明原因。两边都拿不到时至少列出配置的 model
 */
async function listCodex(
  options: Parameters<typeof listModels>[0],
  efforts: string[],
): Promise<ModelList> {
  const command = options.command ?? "codex";
  let config: CodexConfig | undefined;
  let gatewayError: string | undefined;
  let gateway: Promise<string[]> | undefined;
  try {
    config = (options.codexConfig ?? resolveCodexConfig)({
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const api = resolveCodexApi(config);
    if (api.kind === "gateway") {
      proxyFetch(options);
      gateway = fetchCodexModels(api, options.fetch);
    }
  } catch (error) {
    gatewayError = errorText(error);
  }
  const catalog = Promise.resolve()
    .then(() => (options.listCodex ?? defaultCodexLister)(command))
    .then((result) => unique(parseCodex(result)));
  const [fetched, listed] = await Promise.allSettled([
    gateway ?? Promise.resolve(undefined),
    catalog,
  ]);
  const known = listed.status === "fulfilled" ? listed.value : undefined;
  const model = config?.model;
  if (fetched.status === "fulfilled" && fetched.value) {
    const byId = new Map((known ?? []).map((entry) => [entry.id, entry]));
    const models = fetched.value
      .map((id) => byId.get(id) ?? entry(id))
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    return {
      provider: "codex",
      source: "runtime",
      models: withCodexDefault(unique(models), model),
      efforts,
    };
  }
  if (fetched.status === "rejected") gatewayError = errorText(fetched.reason);
  if (known) {
    return {
      provider: "codex",
      // 网关没拉到：model/list 只是 Codex 自带的目录，不是网关上的完整列表
      source: gatewayError ? "preset" : "runtime",
      models: withCodexDefault(known, model),
      efforts,
      ...(gatewayError ? { error: gatewayError } : {}),
    };
  }
  return {
    provider: "codex",
    source: "preset",
    models: withCodexDefault([], model),
    efforts,
    error: gatewayError ?? errorText((listed as PromiseRejectedResult).reason),
  };
}

const PROVIDERS: readonly ModelProvider[] = [
  "codex",
  "claude",
  "copilot",
  "opencode",
  "omp",
  "openclaw",
  "gemini",
  "agy",
];

export async function modelsCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    options: {
      provider: { type: "string", default: "codex" },
      command: { type: "string" },
      cwd: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(usage);
    return;
  }
  const provider = parsed.values.provider as ModelProvider;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`不支持的 provider “${provider}”；可用：${PROVIDERS.join("、")}。`);
  }
  const result = await listModels({
    provider,
    ...(parsed.values.command ? { command: parsed.values.command } : {}),
    ...(parsed.values.cwd ? { cwd: parsed.values.cwd } : {}),
  });
  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.error) console.log(`拉取模型列表失败：${result.error}`);
  if (result.presetReason === "oauth")
    console.log("（Claude 用账号登录、没有 API key，列不出完整列表，以下是常用选项，也可以手填）");
  else if (result.presetReason === "cloud")
    console.log(
      "（Claude 走 Bedrock / Vertex 等云平台，列不出完整列表，以下是常用选项，也可以手填）",
    );
  else if (result.source === "preset")
    console.log("（运行时没有列模型的命令，以下是常用选项，也可以手填）");
  for (const model of result.models) {
    console.log(
      `${model.id}${model.label ? `  ${model.label}` : ""}${
        model.description ? `（${model.description}）` : ""
      }${model.isDefault ? "  （默认）" : ""}${
        model.efforts ? `  思考强度：${model.efforts.join("/")}` : ""
      }`,
    );
  }
  if (result.efforts.length) console.log(`思考强度：${result.efforts.join("、")}`);
}
