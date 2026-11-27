import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  serverText,
  zhText,
  type CcSwitchProvider,
  type CreateRuntimeProfileRequest,
  type RuntimeCredentialProvider,
  type RuntimeProfile,
  type RuntimeProfiles,
  type ServerText,
  type SwitchRuntimeProfileRequest,
  type UpdateRuntimeProfileRequest,
} from "@superhive/protocol";
import {
  appendToml,
  parseJsonc,
  parseToml,
  scanToml,
  setJsoncValue,
  setTomlValue,
  tomlBareKey,
  tomlKey,
  tomlLiteral,
  tomlValue,
} from "./config-edit.js";
import { HiveError } from "./database.js";
import type { SecretBox } from "./im/secret-box.js";
import { maskSecret, maskUrl, type RuntimeCredentialStore } from "./runtime-credentials.js";

/**
 * 运行时的多套供应商（只给本机房主）：每个运行时存多套「接口地址 + key」，Claude Code、Codex 另有一档
 * 「官方订阅」（账号登录），一键切换。
 *
 * - 存在 Server 数据库的 runtime_profiles 表里，key 用和 IM 凭据同一把本机密钥加密（AES-256-GCM）；
 *   列表只给打码后的值，完整值不出 Server。
 * - 切换只改 CLI 自己的配置，走 RuntimeCredentialStore 的备份 + 原子替换：
 *   Claude Code 只动 settings.json 的 env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN（或已在用的
 *   ANTHROPIC_API_KEY），切到官方就删掉这三项，其余设置（模型、权限、插件、hook）原样保留；
 *   Codex 只动 config.toml 顶层的 model_provider 和对应 [model_providers.<id>] 的 base_url、
 *   experimental_bearer_token，切到官方就删掉 model_provider（回到内置 openai），auth.json 不碰，
 *   登录态由 `codex login` 自己写；其它运行时改当前 provider 条目的地址和 key（同「接入」里的修改）。
 * - 切换前 CLI 现在的地址和 key 不属于任何一套时，先自动存成一套（来源 current），切走也找得回来。
 * - 和 cc-switch 共存：只读它的数据库（~/.cc-switch/cc-switch.db），列出它存的 Claude / Codex 供应商、
 *   可以导入；不写它的任何文件。cc-switch 切换时会把 live 配置回填进它记的「当前供应商」，
 *   所以在这里切换后要提示：cc-switch 显示的当前供应商不会跟着变，下次在 cc-switch 里切换前先切回去。
 */

export type RuntimeProfileStoreOptions = {
  db: Database.Database;
  box: SecretBox;
  credentials: RuntimeCredentialStore;
  /** 默认 ~/.cc-switch */
  ccSwitchDir?: string;
  /** macOS 钥匙串里有没有这一项（只查有没有，不取值）；测试注入 */
  keychainHas?: (service: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  now?: () => number;
};

type Row = {
  id: string;
  provider: RuntimeCredentialProvider;
  name: string;
  base_url: string;
  api_key: string;
  provider_id: string | null;
  source: RuntimeProfile["source"];
  created_at: string;
  updated_at: string;
};

type Live = { baseUrl: string | undefined; apiKey: string | undefined };

/** 有官方订阅（账号登录）这一档的运行时 */
const OFFICIAL: Partial<Record<RuntimeCredentialProvider, { loginCommand: string }>> = {
  claude: { loginCommand: "claude auth login" },
  codex: { loginCommand: "codex login" },
};

/** cc-switch 里对应的 app_type；只列独占式的（切换时整份替换 live 配置、会回填） */
const CC_SWITCH_APP: Partial<Record<RuntimeCredentialProvider, { app: string; setting: string }>> =
  {
    claude: { app: "claude", setting: "currentProviderClaude" },
    codex: { app: "codex", setting: "currentProviderCodex" },
  };

/** Claude Code 切到官方后照样生效、官方未必认的设置 */
const CLAUDE_LEFTOVER_ENV = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];
/** cc-switch 代理接管时写进 live 配置的 key 占位符 */
const CC_SWITCH_PROXY_KEY = "PROXY_MANAGED";
const CLAUDE_CREDENTIAL_ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

const sameUrl = (a: string | undefined, b: string | undefined) =>
  Boolean(a && b) && a!.replace(/\/+$/, "") === b!.replace(/\/+$/, "");

/** 自动命名：用地址的主机名 */
function hostName(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

function notEditable(reason: ServerText): never {
  throw new HiveError(
    "RUNTIME_PROFILE_NOT_SWITCHABLE",
    serverText("error.runtimeProfiles.notSwitchable", { reason }),
  );
}

export class RuntimeProfileStore {
  private readonly db: Database.Database;
  private readonly box: SecretBox;
  private readonly credentials: RuntimeCredentialStore;
  private readonly ccSwitchDir: string;
  private readonly keychainHas: (service: string) => Promise<boolean>;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;

  constructor(options: RuntimeProfileStoreOptions) {
    this.db = options.db;
    this.box = options.box;
    this.credentials = options.credentials;
    this.ccSwitchDir = options.ccSwitchDir ?? path.join(options.credentials.home, ".cc-switch");
    this.platform = options.platform ?? process.platform;
    this.keychainHas = options.keychainHas ?? keychainHas;
    this.now = options.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_profiles (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        provider_id TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_profiles_provider ON runtime_profiles(provider, created_at);
    `);
  }

  private rows(provider: RuntimeCredentialProvider): Row[] {
    return this.db
      .prepare("SELECT * FROM runtime_profiles WHERE provider = ? ORDER BY created_at, rowid")
      .all(provider) as Row[];
  }

  private row(provider: RuntimeCredentialProvider, id: string): Row {
    const row = this.db
      .prepare("SELECT * FROM runtime_profiles WHERE provider = ? AND id = ?")
      .get(provider, id) as Row | undefined;
    if (!row) {
      throw new HiveError(
        "RUNTIME_PROFILE_NOT_FOUND",
        serverText("error.runtimeProfiles.notFound"),
      );
    }
    return row;
  }

  private key(row: Row): string {
    return this.box.open(row.api_key);
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private insert(
    provider: RuntimeCredentialProvider,
    input: {
      name: string;
      baseUrl: string;
      apiKey: string;
      providerId?: string | undefined;
      source: Row["source"];
    },
  ): string {
    const id = randomUUID();
    const at = this.stamp();
    this.db
      .prepare(
        `INSERT INTO runtime_profiles
           (id, provider, name, base_url, api_key, provider_id, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        provider,
        input.name,
        input.baseUrl,
        this.box.seal(input.apiKey),
        input.providerId ?? null,
        input.source,
        at,
        at,
      );
    return id;
  }

  /** CLI 现在的地址和 key（完整值，只在 Server 内比对、存档用） */
  private live(provider: RuntimeCredentialProvider): Live {
    return {
      baseUrl: this.credentials.reveal(provider, "baseUrl") ?? undefined,
      apiKey: this.credentials.reveal(provider, "apiKey") ?? undefined,
    };
  }

  private matches(row: Row, live: Live): boolean {
    return sameUrl(row.base_url, live.baseUrl) && this.key(row) === live.apiKey;
  }

  async list(provider: RuntimeCredentialProvider): Promise<RuntimeProfiles> {
    const official = OFFICIAL[provider];
    const officialActive = official ? this.officialActive(provider) : false;
    const live = this.live(provider);
    const rows = this.rows(provider);
    const profiles: RuntimeProfile[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: maskUrl(row.base_url),
      apiKey: maskSecret(this.key(row)),
      active: !officialActive && this.matches(row, live),
      source: row.source,
      ...(row.provider_id ? { providerId: row.provider_id } : {}),
      updatedAt: row.updated_at,
    }));
    const note = this.blocker(provider);
    return {
      provider,
      profiles,
      official: official
        ? {
            active: officialActive,
            login: await this.login(provider),
            loginCommand: official.loginCommand,
            leftover: this.leftover(provider),
          }
        : null,
      unsaved:
        !officialActive &&
        Boolean(live.baseUrl && live.apiKey) &&
        !rows.some((row) => this.matches(row, live)),
      ...(note ? { note: zhText(note), noteText: note } : {}),
      ccSwitch: this.ccSwitch(provider, rows),
    };
  }

  loginCommand(provider: RuntimeCredentialProvider): string | undefined {
    return OFFICIAL[provider]?.loginCommand;
  }

  /** 不能切换的原因；能切换时 undefined */
  private blocker(provider: RuntimeCredentialProvider): ServerText | undefined {
    const runtime = this.credentials.get(provider);
    // cc-switch 的代理接管：地址指向本机代理、key 是占位符，切换由 cc-switch 的代理负责
    if (this.credentials.reveal(provider, "apiKey") === CC_SWITCH_PROXY_KEY) {
      return serverText("runtimeProfiles.note.ccSwitchProxy");
    }
    if (provider === "codex") {
      const text = readText(this.codexConfig()) ?? "";
      if (text && !parseToml(text)) {
        return serverText("error.runtimeCredentials.unreadable", {
          file: this.credentials.display(this.codexConfig()),
          reason: "TOML",
        });
      }
      if (tomlValue(scanToml(text), [], "model_provider") === "complex") {
        return serverText("runtimeCredentials.note.complex");
      }
      return undefined;
    }
    if (provider === "claude") {
      const file = path.join(this.credentials.claudeDir, "settings.json");
      return record(parseJsonc(readText(file) ?? "")) === undefined
        ? serverText("error.runtimeCredentials.unreadable", {
            file: this.credentials.display(file),
            reason: "JSON",
          })
        : undefined;
    }
    // 这几处的说明都是本文件里用 serverText 生成的
    if (!runtime.configured) return runtime.noteText as ServerText | undefined;
    if (!runtime.baseUrl.editable) return runtime.baseUrl.noteText as ServerText | undefined;
    if (!runtime.apiKey.editable) return runtime.apiKey.noteText as ServerText | undefined;
    return undefined;
  }

  create(provider: RuntimeCredentialProvider, input: CreateRuntimeProfileRequest): string {
    if ("fromCurrent" in input) {
      const live = this.live(provider);
      if (!live.baseUrl || !live.apiKey) {
        throw new HiveError(
          "RUNTIME_PROFILE_NOTHING_TO_SAVE",
          serverText("error.runtimeProfiles.nothingToSave"),
        );
      }
      return this.insert(provider, {
        name: input.name,
        baseUrl: live.baseUrl,
        apiKey: live.apiKey,
        providerId: this.codexProviderId(provider),
        source: "current",
      });
    }
    return this.insert(provider, { ...input, source: "hive" });
  }

  update(provider: RuntimeCredentialProvider, id: string, input: UpdateRuntimeProfileRequest) {
    const row = this.row(provider, id);
    this.db
      .prepare(
        "UPDATE runtime_profiles SET name = ?, base_url = ?, api_key = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        input.name ?? row.name,
        input.baseUrl ?? row.base_url,
        input.apiKey !== undefined ? this.box.seal(input.apiKey) : row.api_key,
        this.stamp(),
        id,
      );
  }

  remove(provider: RuntimeCredentialProvider, id: string) {
    this.row(provider, id);
    this.db.prepare("DELETE FROM runtime_profiles WHERE id = ?").run(id);
  }

  /** 切换；返回切换前自动存下的那一套的名字（没有存就是 undefined） */
  switchTo(
    provider: RuntimeCredentialProvider,
    target: SwitchRuntimeProfileRequest,
  ): { saved?: string } {
    const blocker = this.blocker(provider);
    if (blocker) notEditable(blocker);
    const official = "official" in target;
    if (official && !OFFICIAL[provider]) {
      notEditable(serverText("runtimeProfiles.note.noOfficial"));
    }
    const row = official ? undefined : this.row(provider, target.profileId);
    // 切走前把不属于任何一套的原配置存下来
    let saved: string | undefined;
    const live = this.live(provider);
    const rows = this.rows(provider);
    const officialActive = OFFICIAL[provider] ? this.officialActive(provider) : false;
    if (
      !officialActive &&
      live.baseUrl &&
      live.apiKey &&
      !rows.some((item) => this.matches(item, live)) &&
      !(row && this.matches(row, live))
    ) {
      saved = this.uniqueName(provider, hostName(live.baseUrl) ?? "原配置");
      this.insert(provider, {
        name: saved,
        baseUrl: live.baseUrl,
        apiKey: live.apiKey,
        providerId: this.codexProviderId(provider),
        source: "current",
      });
    }
    if (official) this.applyOfficial(provider);
    else this.applyProfile(provider, row!);
    return saved ? { saved } : {};
  }

  private uniqueName(provider: RuntimeCredentialProvider, base: string): string {
    const names = new Set(this.rows(provider).map((row) => row.name));
    if (!names.has(base)) return base;
    for (let index = 2; ; index++) {
      const name = `${base} (${index})`;
      if (!names.has(name)) return name;
    }
  }

  /* ---------- 写 CLI 配置 ---------- */

  private codexConfig(): string {
    return path.join(this.credentials.codexHome, "config.toml");
  }

  private claudeSettings(): string {
    return path.join(this.credentials.claudeDir, "settings.json");
  }

  /** Codex 当前的自定义 provider（[model_providers.<id>] 存在时） */
  private codexProviderId(provider: RuntimeCredentialProvider): string | undefined {
    if (provider !== "codex") return undefined;
    const tables = scanToml(readText(this.codexConfig()) ?? "");
    const value = tomlValue(tables, [], "model_provider");
    if (!value || value === "complex") return undefined;
    return tables.has(tomlKey(["model_providers", value.value])) ? value.value : undefined;
  }

  private officialActive(provider: RuntimeCredentialProvider): boolean {
    if (provider === "claude") {
      const env = record(record(parseJsonc(readText(this.claudeSettings()) ?? ""))?.env) ?? {};
      return !CLAUDE_CREDENTIAL_ENV.some((name) => str(env[name]));
    }
    if (provider === "codex") {
      const value = tomlValue(scanToml(readText(this.codexConfig()) ?? ""), [], "model_provider");
      return value === undefined || (value !== "complex" && value.value === "openai");
    }
    return false;
  }

  private applyOfficial(provider: RuntimeCredentialProvider) {
    if (provider === "claude") {
      const file = this.claudeSettings();
      const before = readText(file) ?? "";
      let content = before;
      for (const name of CLAUDE_CREDENTIAL_ENV) {
        content = this.edit(file, "JSON", () => setJsoncValue(content, ["env", name], undefined));
      }
      if (before.trim() && content !== before) this.credentials.writeFiles([{ file, content }]);
      return;
    }
    const file = this.codexConfig();
    const before = readText(file) ?? "";
    const content = this.edit(file, "TOML", () =>
      setTomlValue(before, [], "model_provider", undefined),
    );
    if (content !== before) this.credentials.writeFiles([{ file, content }]);
  }

  private applyProfile(provider: RuntimeCredentialProvider, row: Row) {
    const apiKey = this.key(row);
    if (provider === "codex") {
      this.applyCodexProfile(row, apiKey);
      return;
    }
    // Claude Code 和其它运行时：改当前那一项的地址和 key（同「接入」里的修改，带备份和回滚）
    this.credentials.update(provider, { baseUrl: row.base_url, apiKey });
  }

  /**
   * Codex：用这一套记的 [model_providers.<id>]（存在时），否则用当前的自定义 provider，都没有就新建一节；
   * key 写 experimental_bearer_token（优先级高于 auth.json 的 OPENAI_API_KEY），再把 model_provider 指过去。
   * 用 env_key 取 key 的 provider 不改。
   */
  private applyCodexProfile(row: Row, apiKey: string) {
    const file = this.codexConfig();
    const before = readText(file) ?? "";
    const tables = scanToml(before);
    const has = (id: string | undefined) =>
      Boolean(id && tables.has(tomlKey(["model_providers", id])));
    const current = this.codexProviderId("codex");
    const id = has(row.provider_id ?? undefined)
      ? row.provider_id!
      : (current ?? row.provider_id ?? "superhive");
    let content = before;
    if (has(id)) {
      const envKey = tomlValue(tables, ["model_providers", id], "env_key");
      if (envKey) {
        notEditable(
          envKey === "complex"
            ? serverText("runtimeCredentials.note.complex")
            : serverText("runtimeCredentials.note.envKey", { name: envKey.value }),
        );
      }
      content = this.edit(file, "TOML", () => {
        let next = setTomlValue(content, ["model_providers", id], "base_url", row.base_url);
        next = setTomlValue(next, ["model_providers", id], "experimental_bearer_token", apiKey);
        return next;
      });
    } else {
      content = this.edit(file, "TOML", () =>
        appendToml(
          content,
          [
            `[model_providers.${tomlBareKey(id)}]`,
            `name = ${tomlLiteral(id)}`,
            `base_url = ${tomlLiteral(row.base_url)}`,
            `wire_api = "responses"`,
            `experimental_bearer_token = ${tomlLiteral(apiKey)}`,
          ].join("\n"),
        ),
      );
    }
    content = this.edit(file, "TOML", () => setTomlValue(content, [], "model_provider", id));
    this.credentials.writeFiles([{ file, content }]);
  }

  /** 改写失败时不把原文带出去（里面可能有 key 的片段） */
  private edit(file: string, format: string, apply: () => string): string {
    try {
      return apply();
    } catch {
      throw new HiveError(
        "RUNTIME_CREDENTIALS_UNREADABLE",
        serverText("error.runtimeCredentials.unreadable", {
          file: this.credentials.display(file),
          reason: format,
        }),
      );
    }
  }

  /* ---------- 官方订阅：登录态和切过去后仍生效的设置 ---------- */

  private async login(provider: RuntimeCredentialProvider): Promise<"yes" | "no" | "unknown"> {
    if (provider === "codex") {
      const auth = record(
        parseJsonc(readText(path.join(this.credentials.codexHome, "auth.json")) ?? ""),
      );
      if (record(auth?.tokens)) return "yes";
      // cli_auth_credentials_store = "keyring" 时登录态在钥匙串「Codex Auth」里
      if (this.platform === "darwin" && (await this.keychainHas("Codex Auth"))) return "yes";
      return "no";
    }
    // Claude Code：~/.claude.json 的 oauthAccount、~/.claude/.credentials.json（Linux、Windows），
    // macOS 上凭据在钥匙串「Claude Code-credentials」里（只查有没有这一项，不取值）
    const custom = Boolean(this.credentials.env.CLAUDE_CONFIG_DIR);
    const state = record(
      parseJsonc(
        readText(
          custom
            ? path.join(this.credentials.claudeDir, ".claude.json")
            : path.join(this.credentials.home, ".claude.json"),
        ) ?? "",
      ),
    );
    if (record(state?.oauthAccount)) return "yes";
    if (existsSync(path.join(this.credentials.claudeDir, ".credentials.json"))) return "yes";
    if (this.platform === "darwin") {
      if (custom) return "unknown";
      return (await this.keychainHas("Claude Code-credentials")) ? "yes" : "no";
    }
    return "no";
  }

  private leftover(provider: RuntimeCredentialProvider): string[] {
    const env = this.credentials.env;
    const fromShell = (names: string[]) =>
      names.filter((name) => str(env[name])).map((name) => `$${name}`);
    if (provider === "claude") {
      const settings = record(parseJsonc(readText(this.claudeSettings()) ?? "")) ?? {};
      const settingsEnv = record(settings.env) ?? {};
      return [
        ...CLAUDE_LEFTOVER_ENV.filter((name) => str(settingsEnv[name])).map(
          (name) => `env.${name} = ${str(settingsEnv[name])}`,
        ),
        ...(str(settings.apiKeyHelper) ? ["apiKeyHelper"] : []),
        // settings.json 里删掉以后，Server 环境里的同名变量就生效了
        ...fromShell(CLAUDE_CREDENTIAL_ENV),
      ];
    }
    const model = tomlValue(scanToml(readText(this.codexConfig()) ?? ""), [], "model");
    return [
      ...(model && model !== "complex" ? [`model = ${model.value}`] : []),
      ...fromShell(["OPENAI_BASE_URL"]),
    ];
  }

  /* ---------- cc-switch：只读 ---------- */

  private ccSwitch(provider: RuntimeCredentialProvider, rows: Row[]): RuntimeProfiles["ccSwitch"] {
    const found = this.readCcSwitch(provider);
    if (!found) return null;
    const providers: CcSwitchProvider[] = found.providers.map((item) => ({
      id: item.id,
      name: item.name,
      baseUrl: item.baseUrl ? maskUrl(item.baseUrl) : null,
      apiKey: item.apiKey ? maskSecret(item.apiKey) : null,
      current: item.id === found.current,
      imported: rows.some((row) => this.matches(row, item)),
    }));
    const current = found.providers.find((item) => item.id === found.current);
    return {
      current: found.all.find((item) => item.id === found.current)?.name ?? null,
      currentProfile: current
        ? (rows.find((row) => this.matches(row, current))?.name ?? null)
        : null,
      providers,
    };
  }

  /**
   * 读 cc-switch 的数据库（只读打开，不建 -wal/-shm 以外的任何东西）：没装、没有这个运行时的供应商、
   * 读不了时返回 undefined。all 含官方那一档（算当前名字用），providers 只含能导入的（有地址和 key）。
   */
  private readCcSwitch(provider: RuntimeCredentialProvider):
    | {
        current: string | undefined;
        all: Array<{ id: string; name: string }>;
        providers: Array<{ id: string; name: string } & Live & { providerId?: string }>;
      }
    | undefined {
    const app = CC_SWITCH_APP[provider];
    const file = path.join(this.ccSwitchDir, "cc-switch.db");
    if (!app || !existsSync(file)) return undefined;
    let rows: Array<{
      id: string;
      name: string;
      settings_config: string;
      category: string | null;
      is_current: number;
    }>;
    try {
      // cc-switch 用回滚日志、只有一个连接：只读打开，它正在写时等一会儿
      const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 1000 });
      try {
        rows = db
          .prepare(
            `SELECT id, name, settings_config, category, is_current FROM providers
             WHERE app_type = ? ORDER BY COALESCE(sort_index, 999999), created_at, id`,
          )
          .all(app.app) as typeof rows;
      } finally {
        db.close();
      }
    } catch {
      return undefined;
    }
    if (!rows.length) return undefined;
    // 设备级的 settings.json 优先，数据库的 is_current 兜底（cc-switch 自己也这么判断）
    const settings = record(
      parseJsonc(readText(path.join(this.ccSwitchDir, "settings.json")) ?? ""),
    );
    const local = str(settings?.[app.setting]);
    const current =
      local && rows.some((row) => row.id === local)
        ? local
        : rows.find((row) => row.is_current)?.id;
    const providers = rows.flatMap((row) => {
      if (row.category === "official") return [];
      let config: Record<string, unknown> | undefined;
      try {
        config = record(JSON.parse(row.settings_config));
      } catch {
        return [];
      }
      const parsed = provider === "claude" ? claudeEntry(config) : codexEntry(config);
      return parsed?.baseUrl && parsed.apiKey ? [{ id: row.id, name: row.name, ...parsed }] : [];
    });
    return { current, all: rows, providers };
  }

  importCcSwitch(provider: RuntimeCredentialProvider, ids: string[]): number {
    const found = this.readCcSwitch(provider);
    if (!found) {
      throw new HiveError("CC_SWITCH_UNAVAILABLE", serverText("error.runtimeProfiles.ccSwitch"));
    }
    let count = 0;
    for (const item of found.providers) {
      if (!ids.includes(item.id)) continue;
      if (this.rows(provider).some((row) => this.matches(row, item))) continue;
      this.insert(provider, {
        name: this.uniqueName(provider, item.name.trim().slice(0, 60) || "cc-switch"),
        baseUrl: item.baseUrl!,
        apiKey: item.apiKey!,
        providerId: item.providerId,
        source: "cc-switch",
      });
      count++;
    }
    return count;
  }
}

/** cc-switch 存的 Claude 供应商：整份 settings.json 快照，地址和 key 在 env 里 */
function claudeEntry(config: Record<string, unknown> | undefined): Live | undefined {
  const env = record(config?.env);
  if (!env) return undefined;
  return {
    baseUrl: str(env.ANTHROPIC_BASE_URL),
    apiKey: str(env.ANTHROPIC_AUTH_TOKEN) ?? str(env.ANTHROPIC_API_KEY),
  };
}

/** cc-switch 存的 Codex 供应商：config 是整份 config.toml 原文，auth 是整份 auth.json */
function codexEntry(
  config: Record<string, unknown> | undefined,
): (Live & { providerId?: string }) | undefined {
  const toml = typeof config?.config === "string" ? parseToml(config.config) : undefined;
  const id = str(toml?.model_provider);
  if (!toml || !id) return undefined;
  const entry = record(record(toml.model_providers)?.[id]);
  if (!entry) return undefined;
  return {
    providerId: id,
    baseUrl: str(entry.base_url),
    apiKey: str(entry.experimental_bearer_token) ?? str(record(config?.auth)?.OPENAI_API_KEY),
  };
}

/** macOS 钥匙串里有没有这一项：security 不带 -w/-g 只读属性，不取密码、不弹授权框 */
function keychainHas(service: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", service],
      { timeout: 5000, windowsHide: true },
      (error) => resolve(!error),
    );
  });
}
