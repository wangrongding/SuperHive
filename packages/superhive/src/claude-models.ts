import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Claude Agent 实际在用的接口能列出哪些模型：按 Claude Code 自己的优先级算出接口地址和密钥，
 * 再请求 GET {base}/v1/models（Anthropic 格式分页；兼容网关给的 OpenAI 格式 {data:[{id}]}）。
 *
 * 环境变量的优先级（后面的盖过前面的），和 Agent 启动后 Claude Code 读到的一致：
 * Agent 进程的环境变量（本机 Agent 继承 Server 的）< $CLAUDE_CONFIG_DIR/settings.json（默认 ~/.claude）的 env
 * < 工作目录 .claude/settings.json < .claude/settings.local.json < 托管配置 managed-settings.json。
 * 密钥的优先级同 Claude Code：ANTHROPIC_AUTH_TOKEN（Bearer）> ANTHROPIC_API_KEY（x-api-key）> apiKeyHelper；
 * 都没有就是用账号登录（OAuth），列不出账号能用的全部模型。
 *
 * 密钥只放在请求头里：不进日志、错误信息和返回值。
 */

export type ClaudeApi =
  | {
      kind: "key";
      baseUrl: string;
      /** 请求头：x-api-key 或 Authorization */
      headers: Record<string, string>;
      /** 出错时要从文字里抹掉的值 */
      secret: string;
    }
  | { kind: "oauth" }
  | { kind: "cloud" };

export type ClaudeApiOptions = {
  /** Agent 进程的环境变量；默认 process.env */
  env?: NodeJS.ProcessEnv;
  /** Agent 的工作目录：项目级 .claude/settings(.local).json 会盖过全局配置 */
  cwd?: string;
  home?: string;
  /** 托管配置的位置；默认按系统的固定位置 */
  managedSettings?: string;
  /** 跑 apiKeyHelper 拿密钥（测试注入）；默认用 shell 执行，10 秒超时 */
  runHelper?: (command: string, env: NodeJS.ProcessEnv) => Promise<string>;
};

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const HELPER_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 10;
const MAX_MODELS = 300;

const ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

function managedSettingsFile(): string {
  if (process.platform === "darwin")
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

function readSettings(file: string): { env: Record<string, unknown>; helper?: string } | undefined {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;
  const record = data as { env?: unknown; apiKeyHelper?: unknown };
  const env =
    record.env && typeof record.env === "object" ? (record.env as Record<string, unknown>) : {};
  const helper = typeof record.apiKeyHelper === "string" ? record.apiKeyHelper.trim() : "";
  return { env, ...(helper ? { helper } : {}) };
}

function value(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function truthy(raw: string | undefined): boolean {
  return raw !== undefined && !/^(0|false|no|off)$/i.test(raw);
}

const defaultRunHelper = (command: string, env: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) =>
    exec(
      command,
      { env, timeout: HELPER_TIMEOUT_MS, encoding: "utf8", windowsHide: true },
      (error, stdout) =>
        // 不带 stderr 和命令输出：可能就是密钥
        error ? reject(new Error("apiKeyHelper 执行失败")) : resolve(stdout),
    ),
  );

/** 按 Claude Code 的优先级算出这个 Agent 实际用的接口地址和认证方式 */
export async function resolveClaudeApi(options: ClaudeApiOptions = {}): Promise<ClaudeApi> {
  const processEnv = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const configDir = value(processEnv.CLAUDE_CONFIG_DIR) ?? path.join(home, ".claude");
  const files = [
    path.join(configDir, "settings.json"),
    ...(options.cwd
      ? [
          path.join(options.cwd, ".claude", "settings.json"),
          path.join(options.cwd, ".claude", "settings.local.json"),
        ]
      : []),
    options.managedSettings ?? managedSettingsFile(),
  ];
  const env: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) env[key] = value(processEnv[key]);
  let helper: string | undefined;
  for (const file of files) {
    const settings = readSettings(file);
    if (!settings) continue;
    for (const key of ENV_KEYS) {
      if (key in settings.env) env[key] = value(settings.env[key]);
    }
    if (settings.helper) helper = settings.helper;
  }
  if (
    truthy(env.CLAUDE_CODE_USE_BEDROCK) ||
    truthy(env.CLAUDE_CODE_USE_VERTEX) ||
    truthy(env.CLAUDE_CODE_USE_FOUNDRY)
  )
    return { kind: "cloud" };
  const baseUrl = (env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
  if (env.ANTHROPIC_AUTH_TOKEN) {
    const secret = env.ANTHROPIC_AUTH_TOKEN;
    return { kind: "key", baseUrl, headers: { authorization: `Bearer ${secret}` }, secret };
  }
  if (env.ANTHROPIC_API_KEY) {
    const secret = env.ANTHROPIC_API_KEY;
    return { kind: "key", baseUrl, headers: { "x-api-key": secret }, secret };
  }
  if (helper) {
    const secret = (
      await (options.runHelper ?? defaultRunHelper)(helper, { ...processEnv })
    ).trim();
    if (!secret) throw new Error("apiKeyHelper 没有输出密钥");
    // Claude Code 把 apiKeyHelper 的输出同时放进这两个头
    return {
      kind: "key",
      baseUrl,
      headers: { "x-api-key": secret, authorization: `Bearer ${secret}` },
      secret,
    };
  }
  return { kind: "oauth" };
}

export type ClaudeModel = { id: string; label?: string };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** 给人看的失败原因；不带密钥 */
function describeFailure(error: unknown, host: string, seconds: number): string {
  const failure = error as { name?: string; cause?: { code?: unknown; name?: string } };
  if (failure?.name === "TimeoutError" || failure?.cause?.name === "TimeoutError")
    return `请求 ${host} 超时（${seconds} 秒）`;
  const code = typeof failure?.cause?.code === "string" ? failure.cause.code : undefined;
  if (code) return `连不上 ${host}（${code}）`;
  return `连不上 ${host}（${error instanceof Error ? error.message : String(error)}）`;
}

function statusReason(status: number, host: string, detail: string): string {
  const tail = detail ? `：${detail}` : "";
  if (status === 401) return `${host} 返回 401，密钥无效或已过期${tail}`;
  if (status === 403) return `${host} 返回 403，这个密钥没有列模型的权限${tail}`;
  if (status === 404) return `${host} 返回 404，这个接口不支持列模型（/v1/models）${tail}`;
  return `${host} 返回 ${status}${tail}`;
}

/** 响应里的错误说明：Anthropic { error: { message } }、OpenAI 同形，或纯文本 */
async function errorDetail(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    return "";
  }
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : (value(parsed.error?.message) ?? value(parsed.message));
    if (message) return message;
  } catch {
    // 不是 JSON
  }
  return body.trim().startsWith("<") ? "" : body.trim();
}

/** 设了 HTTPS_PROXY 等代理时让 fetch 走代理（Node 24.5+ 才有；没有就直连），和 Claude Code 一致 */
export function useEnvProxy(
  env: NodeJS.ProcessEnv,
  setGlobal: ((env: NodeJS.ProcessEnv) => unknown) | undefined,
): void {
  const hasProxy = Object.keys(env).some(
    (key) => /^(https?|all)_proxy$/i.test(key) && value(env[key]),
  );
  if (hasProxy && setGlobal) setGlobal(env);
}

/**
 * GET {base}/v1/models，按 has_more / last_id 翻页取完；整个过程 15 秒超时。
 * 失败抛出看得懂的原因（401、404、超时、连不上），不带密钥
 */
export async function fetchClaudeModels(
  api: Extract<ClaudeApi, { kind: "key" }>,
  fetchImpl: FetchLike = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ClaudeModel[]> {
  const host = hostOf(api.baseUrl);
  const redact = (text: string) =>
    (api.secret ? text.split(api.secret).join("***") : text).replace(/\s+/g, " ").slice(0, 200);
  const signal = AbortSignal.timeout(timeoutMs);
  const models: ClaudeModel[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${api.baseUrl}/v1/models?limit=${PAGE_LIMIT}${
      after ? `&after_id=${encodeURIComponent(after)}` : ""
    }`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          ...api.headers,
          "anthropic-version": ANTHROPIC_VERSION,
          accept: "application/json",
        },
        signal,
      });
    } catch (error) {
      throw new Error(redact(describeFailure(error, host, Math.ceil(timeoutMs / 1000))));
    }
    if (!response.ok) {
      throw new Error(redact(statusReason(response.status, host, await errorDetail(response))));
    }
    let body: { data?: unknown; has_more?: unknown; last_id?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch (error) {
      if ((error as { name?: string })?.name === "TimeoutError")
        throw new Error(`请求 ${host} 超时（${Math.ceil(timeoutMs / 1000)} 秒）`);
      throw new Error(`${host} 返回的不是模型列表（不是 JSON）`);
    }
    if (!Array.isArray(body?.data)) throw new Error(`${host} 返回的不是模型列表（没有 data）`);
    for (const item of body.data as Array<Record<string, unknown> | null>) {
      const id = value(item?.id);
      if (!id) continue;
      const label = value(item?.display_name) ?? value(item?.name);
      models.push({ id, ...(label && label !== id ? { label } : {}) });
    }
    const last = value(body.last_id) ?? models.at(-1)?.id;
    if (body.has_more !== true || !last || last === after || models.length >= MAX_MODELS) break;
    after = last;
  }
  return models;
}
