import { createHmac, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import {
  serverText,
  type McpCatalogEntry,
  type McpCatalogParam,
  type RuntimeCredentialProvider,
  type RuntimeInstallRequest,
  type RuntimeMcpServerInput,
  type ServerText,
} from "@superhive/protocol";
import { HiveError } from "./database.js";
import { MCP_CATALOG_VERSION } from "./mcp-catalog.js";
import { RUNTIME_LABELS } from "./runtime-skills.js";

/**
 * MCP 快速安装：把精选清单里的配方和填的参数解析成一份具体的 MCP 配置，并管理「冻结的安装计划」。
 * - 只接受清单里的配方 ID + 参数，没有任意命令的入口；参数逐项校验，密钥只能进 env / 请求头，
 *   不进命令行参数；预览里含密钥的值都打码。
 * - 计划只记参数摘要（进程内随机密钥的 HMAC）和各目标配置文件的哈希，不记参数值；确认时客户端
 *   再带上同一份参数，摘要、哈希都对得上、也没过期才写，用过一次就作废。
 */

export const MASK = "••••••";
const PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_PLANS = 100;
const PLACEHOLDER = /\{([a-z][a-zA-Z0-9]*)\}/g;
// 换行、制表等控制字符会改写配置文件或请求头的结构
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const LIMITS: Record<McpCatalogParam["kind"], number> = {
  text: 512,
  path: 1024,
  paths: 8192,
  secret: 4096,
};

export type ResolvedMcp = {
  input: RuntimeMcpServerInput;
  headers?: Record<string, string>;
  /** 给人看的：密钥打码 */
  display: {
    command?: string;
    args?: string[];
    url?: string;
    env: Array<{ key: string; value: string; secret: boolean }>;
    headers: Array<{ key: string; value: string; secret: boolean }>;
  };
};

function paramError(param: McpCatalogParam | string, reason: ServerText): HiveError {
  const field = typeof param === "string" ? param : param.label.zh;
  return new HiveError(
    "RUNTIME_CONFIG_INVALID",
    serverText("error.runtimeInstall.param", { field, reason }),
  );
}

const isAbsolute = (value: string) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value);

/** 校验参数，返回去掉首尾空白后的值；可选参数没填的不出现在结果里 */
function checkParams(entry: McpCatalogEntry, raw: Record<string, string>): Map<string, string[]> {
  const known = new Map(entry.params.map((param) => [param.id, param]));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw paramError(key, serverText("error.runtimeInstall.param.unknown"));
  }
  const values = new Map<string, string[]>();
  for (const param of entry.params) {
    const text = (raw[param.id] ?? "").trim();
    if (!text) {
      if (param.required)
        throw paramError(param, serverText("error.runtimeInstall.param.required"));
      continue;
    }
    if (text.length > LIMITS[param.kind]) {
      throw paramError(param, serverText("error.runtimeInstall.param.format"));
    }
    const list =
      param.kind === "paths"
        ? text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        : [text];
    if (list.length > 20 || list.some((item) => CONTROL.test(item))) {
      throw paramError(param, serverText("error.runtimeInstall.param.format"));
    }
    if ((param.kind === "path" || param.kind === "paths") && !list.every(isAbsolute)) {
      throw paramError(param, serverText("error.runtimeInstall.param.absolute"));
    }
    values.set(param.id, list);
  }
  return values;
}

function referenced(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/**
 * 按配方和参数生成 MCP 配置。platform 只影响 Windows：npx 是 .cmd，CLI 直接起不来，
 * 按各 CLI 文档的写法包成 `cmd /c npx …`
 */
export function resolveRecipe(
  entry: McpCatalogEntry,
  raw: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): ResolvedMcp {
  const values = checkParams(entry, raw);
  const kinds = new Map(entry.params.map((param) => [param.id, param.kind]));
  const fill = (template: string, mask: boolean) =>
    template.replace(PLACEHOLDER, (_, id: string) =>
      mask && kinds.get(id) === "secret" ? MASK : (values.get(id) ?? []).join("\n"),
    );
  /** 模板里引用的参数都有值才保留这一项 */
  const present = (template: string) => referenced(template).every((id) => values.has(id));
  const isSecret = (template: string) =>
    referenced(template).some((id) => kinds.get(id) === "secret");

  const pairs = (map: Record<string, string> | undefined) =>
    Object.entries(map ?? {}).filter(([, template]) => present(template));
  const env = pairs(entry.env);
  const headers = pairs(entry.headers);
  const display = {
    env: env.map(([key, template]) => ({
      key,
      value: fill(template, true),
      secret: isSecret(template),
    })),
    headers: headers.map(([key, template]) => ({
      key,
      value: fill(template, true),
      secret: isSecret(template),
    })),
  };

  if (entry.transport === "stdio") {
    const args = (entry.args ?? []).filter(present).flatMap((template) => {
      // 整项就是一个 paths 参数时展开成多项（一个目录一项）
      const only = /^\{([a-z][a-zA-Z0-9]*)\}$/.exec(template)?.[1];
      if (only && kinds.get(only) === "paths") return values.get(only) ?? [];
      return [fill(template, false)];
    });
    let command = entry.command!;
    let argv = args;
    if (platform === "win32" && command === "npx") {
      command = "cmd";
      argv = ["/c", "npx", ...args];
    }
    return {
      input: {
        transport: "stdio",
        command,
        args: argv,
        env: Object.fromEntries(env.map(([key, template]) => [key, fill(template, false)])),
        enabled: true,
      },
      display: { ...display, command, args: argv },
    };
  }
  const realHeaders = Object.fromEntries(
    headers.map(([key, template]) => [key, fill(template, false)]),
  );
  return {
    input: { transport: entry.transport, url: entry.url!, env: {}, enabled: true },
    ...(headers.length ? { headers: realHeaders } : {}),
    display: { ...display, url: entry.url! },
  };
}

/** 能不能装进这个 CLI：配方没声明的直接拒绝（CLI 本身支不支持 MCP、有没有同名由 preflight 查） */
export function checkRuntime(entry: McpCatalogEntry, target: RuntimeCredentialProvider) {
  if (!entry.runtimes.includes(target)) {
    throw new HiveError(
      "RUNTIME_CREDENTIALS_NOT_EDITABLE",
      serverText("error.runtimeInstall.runtime", {
        name: entry.title,
        target: RUNTIME_LABELS[target],
      }),
    );
  }
}

type Plan = { digest: string; hashes: Record<string, string | null>; expiresAt: number };

export class InstallPlans {
  private readonly key = randomBytes(32);
  private readonly plans = new Map<string, Plan>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 参数（含密钥）的摘要：只在这个进程里能算出来，计划里不留原值 */
  digest(request: RuntimeInstallRequest, targets: RuntimeCredentialProvider[]): string {
    const params = Object.entries(request.params)
      .map(([key, value]): [string, string] => [key, value.trim()])
      .filter(([, value]) => value)
      .sort(([a], [b]) => a.localeCompare(b));
    return createHmac("sha256", this.key)
      .update(
        JSON.stringify([MCP_CATALOG_VERSION, request.recipeId, request.name, params, targets]),
      )
      .digest("hex");
  }

  create(digest: string, hashes: Record<string, string | null>) {
    const now = this.now();
    for (const [id, plan] of this.plans) if (plan.expiresAt <= now) this.plans.delete(id);
    while (this.plans.size >= MAX_PLANS) this.plans.delete(this.plans.keys().next().value!);
    const id = randomUUID();
    const expiresAt = now + PLAN_TTL_MS;
    this.plans.set(id, { digest, hashes, expiresAt });
    return { id, expiresAt };
  }

  /** 用掉这份计划：不管对不对得上都作废，对不上就要重新预览 */
  take(id: string, digest: string, hashes: Record<string, string | null>): boolean {
    const plan = this.plans.get(id);
    this.plans.delete(id);
    if (!plan || plan.expiresAt <= this.now() || plan.digest !== digest) return false;
    const keys = Object.keys(hashes);
    return (
      keys.length === Object.keys(plan.hashes).length &&
      keys.every((key) => key in plan.hashes && plan.hashes[key] === hashes[key])
    );
  }
}

export function stalePlan(): HiveError {
  return new HiveError("RUNTIME_INSTALL_PLAN_STALE", serverText("error.runtimeInstall.stale"));
}

export function unknownRecipe(): HiveError {
  return new HiveError("RUNTIME_INSTALL_UNKNOWN", serverText("error.runtimeInstall.unknown"));
}
