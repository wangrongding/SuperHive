import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { describeFetchFailure, fetchStatusReason, responseErrorDetail } from "./claude-models.js";
import type { FetchLike } from "./claude-models.js";

/**
 * Codex Agent 实际在用的模型接口能列出哪些模型。Codex 自己的 model/list 只列内置目录（或 model_catalog_json
 * 指的文件），走自定义网关时既不含网关上的模型，也可能不含配置里在用的模型；所以按 Codex 实际生效的配置
 * 找到当前 provider，自定义网关就请求 GET {base_url}/models（OpenAI 格式 { data: [{ id }] }）。
 *
 * 配置层（后面的盖过前面的），与 Codex 一致：/etc/codex/config.toml < $CODEX_HOME/config.toml（默认 ~/.codex）
 * < 项目里从项目根（向上找 .git）到工作目录各层的 .codex/config.toml（项目在 [projects] 里标了 trusted 才加载）
 * < /etc/codex/managed_config.toml；之后 profile = "x" 选中的 [profiles.x] 再盖过顶层的 model、model_provider。
 * Hive 起 Codex 时不传改模型、改 provider 的 -c，所以不用管命令行覆盖。
 *
 * 认证与 Codex 一致：env_key 指的环境变量 > experimental_bearer_token > requires_openai_auth 时 auth.json 的
 * OPENAI_API_KEY（用 ChatGPT 账号登录的拿不到 key）；再加上 http_headers 和 env_http_headers（环境变量有值才带）、
 * query_params。内置的 openai 不请求（官方接口列出的大多不是 Codex 能用的模型），退回 model/list。
 *
 * 密钥只放在请求头里：不进日志、错误信息和返回值。
 */

export type CodexApi =
  | {
      kind: "gateway";
      providerId: string;
      baseUrl: string;
      headers: Record<string, string>;
      query: Record<string, string>;
      /** 出错时要从文字里抹掉的值 */
      secrets: string[];
    }
  /** official：内置 openai；account：要用 ChatGPT 账号登录；unsupported：认证方式（auth 命令等）不支持 */
  | { kind: "official" | "account" | "unsupported"; providerId: string };

export type CodexConfig = {
  /** 当前生效的 model（没配就是 Codex 自己的默认） */
  model?: string;
  providerId: string;
  /** 当前 provider 的配置小节（内置 provider 没有） */
  provider?: Record<string, unknown>;
  codexHome: string;
};

export type CodexConfigOptions = {
  /** Agent 进程的环境变量；默认 process.env */
  env?: NodeJS.ProcessEnv;
  /** Agent 的工作目录：项目里的 .codex/config.toml 会盖过全局配置 */
  cwd?: string;
  home?: string;
  /** 系统级配置目录；默认 /etc/codex（Windows 没有） */
  systemDir?: string;
};

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MODELS = 300;

/** 内置的本地 provider（不需要认证）；openai 单独处理 */
const BUILTIN_LOCAL: Record<string, string> = {
  oss: "http://localhost:11434/v1",
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
};

type Table = Record<string, unknown>;

function isTable(raw: unknown): raw is Table {
  return Boolean(raw) && typeof raw === "object" && !Array.isArray(raw);
}

function str(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function readToml(file: string): Table | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = parseToml(text);
    return isTable(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 深合并（表逐层合并，其他值整体覆盖），和 Codex 合并配置层一样 */
function merge(base: Table, over: Table): Table {
  const out: Table = { ...base };
  for (const [key, next] of Object.entries(over)) {
    const prev = out[key];
    out[key] = isTable(prev) && isTable(next) ? merge(prev, next) : next;
  }
  return out;
}

function exists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 从工作目录向上找项目根（有 .git 的目录）；找不到就只看工作目录自己 */
function projectRoot(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (exists(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** git worktree 的主仓库目录（.git 是文件、写着 gitdir: <主仓库>/.git/worktrees/<名字>） */
function mainRepoRoot(root: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(root, ".git"), "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (!match) return undefined;
  const gitdir = path.resolve(root, match[1]!.trim());
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const index = gitdir.lastIndexOf(marker);
  return index >= 0 ? gitdir.slice(0, index) : undefined;
}

function trusted(projects: unknown, dirs: Array<string | undefined>): boolean {
  if (!isTable(projects)) return false;
  return dirs.some((dir) => {
    const entry = dir ? projects[dir] : undefined;
    return isTable(entry) && entry.trust_level === "trusted";
  });
}

/** 项目里要加载的 .codex/config.toml：从项目根到工作目录，越靠近工作目录越优先 */
function projectLayers(cwd: string, projects: unknown, skip: string): string[] {
  const dir = path.resolve(cwd);
  const root = projectRoot(dir);
  if (!trusted(projects, [dir, root, root ? mainRepoRoot(root) : undefined])) return [];
  const dirs: string[] = [];
  for (let at = dir; ; at = path.dirname(at)) {
    dirs.unshift(at);
    if (!root || at === root || path.dirname(at) === at) break;
  }
  return dirs
    .map((at) => path.join(at, ".codex", "config.toml"))
    .filter((file) => path.resolve(file) !== path.resolve(skip));
}

/** 按 Codex 的配置层合出当前的 model 和 provider */
export function resolveCodexConfig(options: CodexConfigOptions = {}): CodexConfig {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const codexHome = str(env.CODEX_HOME) ?? path.join(home, ".codex");
  const systemDir = options.systemDir ?? (process.platform === "win32" ? "" : "/etc/codex");
  const userFile = path.join(codexHome, "config.toml");
  const user = readToml(userFile) ?? {};
  const files = [
    ...(systemDir ? [path.join(systemDir, "config.toml")] : []),
    userFile,
    ...(options.cwd ? projectLayers(options.cwd, user.projects, userFile) : []),
    ...(systemDir ? [path.join(systemDir, "managed_config.toml")] : []),
  ];
  let config: Table = {};
  for (const file of files) {
    const layer = file === userFile ? user : readToml(file);
    if (layer) config = merge(config, layer);
  }
  const profileName = str(config.profile);
  const profile =
    profileName && isTable(config.profiles) && isTable(config.profiles[profileName])
      ? config.profiles[profileName]
      : {};
  const model = str(profile.model) ?? str(config.model);
  const providerId = str(profile.model_provider) ?? str(config.model_provider) ?? "openai";
  const providers = isTable(config.model_providers) ? config.model_providers : {};
  const provider = isTable(providers[providerId]) ? providers[providerId] : undefined;
  return {
    ...(model ? { model } : {}),
    providerId,
    ...(provider && !(providerId in BUILTIN_LOCAL) && providerId !== "openai" ? { provider } : {}),
    codexHome,
  };
}

function stringMap(raw: unknown): Record<string, string> {
  if (!isTable(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );
}

function authJsonKey(codexHome: string): { key?: string; account: boolean } {
  try {
    const auth = JSON.parse(readFileSync(path.join(codexHome, "auth.json"), "utf8")) as {
      OPENAI_API_KEY?: unknown;
      tokens?: unknown;
    };
    const key = str(auth.OPENAI_API_KEY);
    return key ? { key, account: false } : { account: Boolean(auth.tokens) };
  } catch {
    return { account: false };
  }
}

/** 按 Codex 的规则算出当前 provider 的接口地址和认证请求头 */
export function resolveCodexApi(
  config: CodexConfig,
  env: NodeJS.ProcessEnv = process.env,
): CodexApi {
  const { providerId } = config;
  if (providerId === "openai") return { kind: "official", providerId };
  const local = BUILTIN_LOCAL[providerId];
  if (local) {
    const base = str(env.CODEX_OSS_BASE_URL) ?? local;
    return {
      kind: "gateway",
      providerId,
      baseUrl: base.replace(/\/+$/, ""),
      headers: {},
      query: {},
      secrets: [],
    };
  }
  const provider = config.provider;
  const baseUrl = str(provider?.base_url);
  if (!provider || !baseUrl) return { kind: "unsupported", providerId };
  // 用命令取 token（auth = { command = … }）：不替它执行命令
  if (provider.auth !== undefined) return { kind: "unsupported", providerId };
  const headers: Record<string, string> = { ...stringMap(provider.http_headers) };
  for (const [header, name] of Object.entries(stringMap(provider.env_http_headers))) {
    const value = str(env[name]);
    if (value) headers[header] = value;
  }
  let token: string | undefined;
  const envKey = str(provider.env_key);
  if (envKey) {
    token = str(env[envKey]);
    if (!token) throw new Error(`Codex 配置要求环境变量 ${envKey}，但它没有值`);
  } else if (str(provider.experimental_bearer_token)) {
    token = str(provider.experimental_bearer_token);
  } else if (provider.requires_openai_auth === true) {
    const auth = authJsonKey(config.codexHome);
    if (!auth.key) return { kind: "account", providerId };
    token = auth.key;
  }
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    kind: "gateway",
    providerId,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    headers,
    query: stringMap(provider.query_params),
    secrets: [token, ...Object.values(headers)].filter(
      (value): value is string => typeof value === "string" && value.length >= 8,
    ),
  };
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** GET {base_url}/models（OpenAI 格式），15 秒超时；失败抛出看得懂的原因，不带密钥 */
export async function fetchCodexModels(
  api: Extract<CodexApi, { kind: "gateway" }>,
  fetchImpl: FetchLike = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<string[]> {
  const host = hostOf(api.baseUrl);
  const redact = (text: string) =>
    api.secrets
      .reduce((out, secret) => out.split(secret).join("***"), text)
      .replace(/\s+/g, " ")
      .slice(0, 200);
  const query = new URLSearchParams(api.query).toString();
  const url = `${api.baseUrl}/models${query ? `?${query}` : ""}`;
  const seconds = Math.ceil(timeoutMs / 1000);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { ...api.headers, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(redact(describeFetchFailure(error, host, seconds)));
  }
  if (!response.ok) {
    throw new Error(
      redact(
        fetchStatusReason(response.status, host, await responseErrorDetail(response), "/models"),
      ),
    );
  }
  let body: { data?: unknown; models?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    if ((error as { name?: string })?.name === "TimeoutError")
      throw new Error(`请求 ${host} 超时（${seconds} 秒）`);
    throw new Error(`${host} 返回的不是模型列表（不是 JSON）`);
  }
  // OpenAI 格式是 data；有的网关（Ollama 等）给 models
  const items = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : undefined;
  if (!items) throw new Error(`${host} 返回的不是模型列表（没有 data）`);
  const ids = (items as Array<Record<string, unknown> | null>).flatMap((item) => {
    const id = str(item?.id) ?? str(item?.model) ?? str(item?.name);
    return id ? [id] : [];
  });
  return [...new Set(ids)].slice(0, MAX_MODELS);
}
