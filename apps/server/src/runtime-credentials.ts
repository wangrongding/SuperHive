import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  serverText,
  zhText,
  type RuntimeCredentialEffect,
  type RuntimeCredentialField,
  type RuntimeCredentialFieldInfo,
  type RuntimeCredentialProvider,
  type RuntimeCredentials,
  type ServerText,
  type UpdateRuntimeCredentialsRequest,
} from "@superhive/protocol";
import {
  parseJsonc,
  parseYaml,
  scanToml,
  setJsoncString,
  setTomlString,
  setYamlString,
  tomlKey,
  tomlValue,
  yamlUnsafe,
  type JsonPath,
} from "./config-edit.js";
import { HiveError } from "./database.js";

/**
 * 运行时的接口地址和密钥，直接读写各 CLI 自己的全局配置（终端里的 CLI 读的是同一份，所以会一起变）：
 * - Claude Code：$CLAUDE_CONFIG_DIR/settings.json（默认 ~/.claude）的 env.ANTHROPIC_BASE_URL、
 *   env.ANTHROPIC_AUTH_TOKEN（已有 ANTHROPIC_API_KEY 时改它）；
 * - Codex：$CODEX_HOME/config.toml（默认 ~/.codex）里当前 model_provider 小节的 base_url、
 *   experimental_bearer_token；用内置 OpenAI 或 requires_openai_auth 时密钥在 auth.json 的 OPENAI_API_KEY；
 * - opencode：~/.config/opencode/opencode.jsonc（没有则 opencode.json）里当前模型所属
 *   provider.<id>.options 的 baseURL、apiKey；
 * - omp：~/.omp/agent/models.yml 里 config.yml 的 modelRoles.default 所属 providers.<id> 的 baseUrl、apiKey；
 * - OpenClaw：~/.openclaw/openclaw.json 里 agents.defaults.model 所属 models.providers.<id> 的 baseUrl、apiKey；
 * - Copilot：~/.copilot/providers.json 里当前模型（<provider>/<model>）所属条目的 baseUrl、apiKey（BYOK）。
 * 只改自己那一项、保序就地改；读不懂或改不安全的写法只读并说明原因，不报错也不整份重写。
 *
 * 写之前把原文件备份到同目录（权限 600，只留最近几份），写临时文件 fsync 后改名替换，保持原文件权限；
 * 一次要改两个文件时，后一个失败就把前一个还原。值只经这里读写，不进日志和错误信息。
 */

export type RuntimeCredentialsOptions = {
  home?: string;
  /** 默认 $CLAUDE_CONFIG_DIR 或 ~/.claude */
  claudeDir?: string;
  /** 默认 $CODEX_HOME 或 ~/.codex */
  codexHome?: string;
  /** Claude Code 的托管配置（优先级最高）；默认按系统的固定位置 */
  claudeManagedSettings?: string;
  /** Server 的环境变量（Agent 继承它）；测试注入 */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** 测试注入：模拟写入中途失败 */
  writeFile?: (fd: number, content: string) => void;
};

/** 读取时的上下文：用这个运行时的本机 Agent 的工作目录（检查项目级配置是否覆盖了全局配置） */
export type RuntimeCredentialContext = { cwds?: string[] };

export const RUNTIME_CREDENTIAL_PROVIDERS: readonly RuntimeCredentialProvider[] = [
  "claude",
  "codex",
  "opencode",
  "omp",
  "openclaw",
  "copilot",
];

/** 改完怎么生效：按各运行时在 superhive 里的实际运行方式 */
const EFFECT: Record<RuntimeCredentialProvider, RuntimeCredentialEffect> = {
  // 常驻的 claude 进程按生效凭据的指纹判断能否复用：改了 key 或地址，下一轮新起进程（--resume 接着会话）
  claude: "nextTurn",
  // app-server 常驻，启动时读一次配置
  codex: "restart",
  // ACP 常驻进程
  opencode: "restart",
  omp: "restart",
  // 每轮新起 openclaw 进程，但默认经 gateway 执行
  openclaw: "gateway",
  // 每轮新起 copilot 进程
  copilot: "nextTurn",
};

const BACKUP_KEEP = 5;
const BACKUP_TAG = ".superhive-bak-";
const COPILOT_PROVIDER_ENV = [
  "COPILOT_PROVIDER_BASE_URL",
  "COPILOT_PROVIDER_TYPE",
  "COPILOT_PROVIDER_API_KEY",
  "COPILOT_PROVIDER_BEARER_TOKEN",
];

type Edit = { file: string; format: string; apply: (content: string, value: string) => string };

type Located = {
  info: RuntimeCredentialFieldInfo;
  value: string | undefined;
  /** 改这一项要动的文件和改法；undefined 表示不能改 */
  edit?: Edit;
};

type Snapshot = {
  files: string[];
  configured: boolean;
  note?: ServerText;
  providerId?: string;
  baseUrl: Located;
  apiKey: Located;
};

/** 打码：密钥只露头尾各 4 位；地址只露协议、主机名开头和结尾 */
export function maskSecret(value: string): string {
  if (value.length <= 12) return "•".repeat(Math.max(value.length, 4));
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export function maskUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.host;
    const shown =
      host.length <= 8 ? `${host.slice(0, 2)}••••` : `${host.slice(0, 4)}••••${host.slice(-4)}`;
    return `${url.protocol}//${shown}${url.pathname !== "/" || url.search ? "/…" : ""}`;
  } catch {
    return maskSecret(value);
  }
}

function fieldInfo(
  field: RuntimeCredentialField,
  value: string | undefined,
  location: string,
  editable: boolean,
  note?: ServerText,
): RuntimeCredentialFieldInfo {
  return {
    set: Boolean(value),
    masked: value ? (field === "baseUrl" ? maskUrl(value) : maskSecret(value)) : null,
    editable,
    location,
    ...(note ? { note: zhText(note), noteText: note } : {}),
  };
}

function editable(
  field: RuntimeCredentialField,
  value: unknown,
  location: string,
  edit: Edit,
): Located {
  const text = typeof value === "string" ? value : undefined;
  return { info: fieldInfo(field, text, location, true), value: text, edit };
}

function readOnly(
  field: RuntimeCredentialField,
  location: string,
  note: ServerText,
  value?: string,
): Located {
  return { info: fieldInfo(field, value, location, false, note), value };
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 当前模型 <provider>/<model> 的 provider 部分 */
function providerOf(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

export type Write = { file: string; content: string };

export class RuntimeCredentialStore {
  readonly home: string;
  readonly claudeDir: string;
  readonly codexHome: string;
  private readonly managed: string;
  readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly writeContent: (fd: number, content: string) => void;

  constructor(options: RuntimeCredentialsOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
    this.claudeDir =
      options.claudeDir ?? this.env.CLAUDE_CONFIG_DIR ?? path.join(this.home, ".claude");
    this.codexHome = options.codexHome ?? this.env.CODEX_HOME ?? path.join(this.home, ".codex");
    this.managed =
      options.claudeManagedSettings ??
      (process.platform === "darwin"
        ? "/Library/Application Support/ClaudeCode/managed-settings.json"
        : process.platform === "win32"
          ? "C:\\Program Files\\ClaudeCode\\managed-settings.json"
          : "/etc/claude-code/managed-settings.json");
    this.now = options.now ?? Date.now;
    this.writeContent = options.writeFile ?? ((fd, content) => writeSync(fd, content));
  }

  /** 给人看的路径：家目录写成 ~ */
  display(file: string): string {
    return file.startsWith(this.home + path.sep) ? `~${file.slice(this.home.length)}` : file;
  }

  list(context: (provider: RuntimeCredentialProvider) => RuntimeCredentialContext = () => ({})) {
    return RUNTIME_CREDENTIAL_PROVIDERS.map((provider) => this.get(provider, context(provider)));
  }

  get(
    provider: RuntimeCredentialProvider,
    context: RuntimeCredentialContext = {},
  ): RuntimeCredentials {
    const snapshot = this.snapshot(provider, context);
    return {
      provider,
      files: snapshot.files,
      configured: snapshot.configured,
      ...(snapshot.note ? { note: zhText(snapshot.note), noteText: snapshot.note } : {}),
      ...(snapshot.providerId ? { providerId: snapshot.providerId } : {}),
      effect: EFFECT[provider],
      baseUrl: snapshot.baseUrl.info,
      apiKey: snapshot.apiKey.info,
    };
  }

  /** 完整值：只在本机房主确认后调用 */
  reveal(provider: RuntimeCredentialProvider, field: RuntimeCredentialField): string | null {
    return this.snapshot(provider, {})[field].value ?? null;
  }

  update(
    provider: RuntimeCredentialProvider,
    input: UpdateRuntimeCredentialsRequest,
    context: RuntimeCredentialContext = {},
  ): RuntimeCredentials {
    const fields = (["baseUrl", "apiKey"] as const).filter((field) => input[field] !== undefined);
    // 按文件合并：同一个文件改两项只写一次
    const pending = new Map<string, string>();
    for (const field of fields) {
      const located = this.snapshot(provider, {}, pending)[field];
      if (!located.edit) {
        const reason = located.info.noteText ?? serverText("runtimeCredentials.note.complex");
        throw new HiveError(
          "RUNTIME_CREDENTIALS_NOT_EDITABLE",
          serverText("error.runtimeCredentials.notEditable", { field, reason }),
        );
      }
      const { file, format, apply } = located.edit;
      const current = pending.get(file) ?? readText(file) ?? "";
      let next: string;
      try {
        next = apply(current, input[field]!);
      } catch {
        // 不把解析错误原文带出去：里面可能有值的片段
        throw new HiveError(
          "RUNTIME_CREDENTIALS_UNREADABLE",
          serverText("error.runtimeCredentials.unreadable", {
            file: this.display(file),
            reason: format,
          }),
        );
      }
      pending.set(file, next);
    }
    this.writeFiles([...pending].map(([file, content]) => ({ file, content })));
    return this.get(provider, context);
  }

  private text(file: string, pending?: Map<string, string>): string | undefined {
    return pending?.get(file) ?? readText(file);
  }

  private snapshot(
    provider: RuntimeCredentialProvider,
    context: RuntimeCredentialContext,
    pending?: Map<string, string>,
  ): Snapshot {
    switch (provider) {
      case "claude":
        return this.claude(context, pending);
      case "codex":
        return this.codex(pending);
      case "opencode":
        return this.opencode(pending);
      case "omp":
        return this.omp(pending);
      case "openclaw":
        return this.openclaw(pending);
      case "copilot":
        return this.copilot(pending);
    }
  }

  /** 没装、没配置或读不懂：两项都只读，原因写在运行时上 */
  private notConfigured(
    files: string[],
    note: ServerText,
    location: string,
    providerId?: string,
  ): Snapshot {
    const empty = (): Located => ({
      info: { set: false, masked: null, editable: false, location },
      value: undefined,
    });
    return {
      files,
      configured: false,
      note,
      ...(providerId ? { providerId } : {}),
      baseUrl: empty(),
      apiKey: empty(),
    };
  }

  private missing(file: string): Snapshot {
    const display = this.display(file);
    return this.notConfigured(
      [display],
      serverText("runtimeCredentials.note.missing", { file: display }),
      display,
    );
  }

  private unreadable(file: string, format: string): Snapshot {
    const display = this.display(file);
    return this.notConfigured(
      [display],
      serverText("error.runtimeCredentials.unreadable", { file: display, reason: format }),
      display,
    );
  }

  /** JSON / JSONC 里 path 处的字符串，可就地改 */
  private jsonField(
    field: RuntimeCredentialField,
    file: string,
    data: unknown,
    keys: JsonPath,
    label: string,
  ): Located {
    let value: unknown = data;
    for (const key of keys) value = (value as Record<string | number, unknown> | undefined)?.[key];
    return editable(field, value, `${this.display(file)} → ${label}`, {
      file,
      format: "JSON",
      apply: (content, next) => setJsoncString(content, keys, next),
    });
  }

  private claude(context: RuntimeCredentialContext, pending?: Map<string, string>): Snapshot {
    const file = path.join(this.claudeDir, "settings.json");
    const display = this.display(file);
    const data = record(parseJsonc(this.text(file, pending) ?? ""));
    if (!data) return this.unreadable(file, "JSON");
    const env = record(data.env) ?? {};
    // 已经在用 ANTHROPIC_API_KEY 就改它；否则用 ANTHROPIC_AUTH_TOKEN（Bearer，不会在启动时再问一次是否信任这个 key）
    const keyName =
      str(env.ANTHROPIC_API_KEY) && !str(env.ANTHROPIC_AUTH_TOKEN)
        ? "ANTHROPIC_API_KEY"
        : "ANTHROPIC_AUTH_TOKEN";
    // settings.json 的 env 盖过 shell 里的环境变量，但托管配置和 Agent 工作目录下的项目配置又盖过它
    const overrides = [
      this.managed,
      ...(context.cwds ?? []).flatMap((cwd) => [
        path.join(cwd, ".claude", "settings.json"),
        path.join(cwd, ".claude", "settings.local.json"),
      ]),
    ];
    const shadow = (names: string[]) => {
      for (const override of overrides) {
        const overrideEnv = record(record(parseJsonc(readText(override) ?? ""))?.env);
        const name = names.find((key) => str(overrideEnv?.[key]));
        if (name) return `${this.display(override)} → env.${name}`;
      }
      return undefined;
    };
    const located = (field: RuntimeCredentialField, name: string, shadowNames: string[]) => {
      const result = this.jsonField(field, file, data, ["env", name], `env.${name}`);
      const by = shadow(shadowNames);
      if (by) result.info.shadowedBy = by;
      return result;
    };
    return {
      files: [display],
      configured: true,
      baseUrl: located("baseUrl", "ANTHROPIC_BASE_URL", ["ANTHROPIC_BASE_URL"]),
      apiKey: located("apiKey", keyName, ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]),
    };
  }

  private codex(pending?: Map<string, string>): Snapshot {
    const configFile = path.join(this.codexHome, "config.toml");
    const authFile = path.join(this.codexHome, "auth.json");
    const configDisplay = this.display(configFile);
    const authDisplay = this.display(authFile);
    const configText = this.text(configFile, pending);
    const authText = this.text(authFile, pending);
    if (configText === undefined && authText === undefined) return this.missing(configFile);
    const tables = scanToml(configText ?? "");
    const providerValue = tomlValue(tables, [], "model_provider");
    const complex = serverText("runtimeCredentials.note.complex");

    const authJson = (): Located => {
      const auth = record(parseJsonc(authText ?? ""));
      const location = `${authDisplay} → OPENAI_API_KEY`;
      if (!auth) return readOnly("apiKey", location, complex);
      const value = str(auth.OPENAI_API_KEY);
      // 用 ChatGPT 账号登录（有 tokens 没有 key）时不往里塞 key，免得改掉登录方式
      if (!value && auth.tokens) {
        return readOnly("apiKey", location, serverText("runtimeCredentials.note.chatgpt"));
      }
      return this.jsonField("apiKey", authFile, auth, ["OPENAI_API_KEY"], "OPENAI_API_KEY");
    };

    if (providerValue === "complex") {
      return {
        files: [configDisplay],
        configured: true,
        baseUrl: readOnly("baseUrl", `${configDisplay} → model_provider`, complex),
        apiKey: readOnly("apiKey", `${configDisplay} → model_provider`, complex),
      };
    }
    const id = providerValue?.value ?? "openai";
    const table = ["model_providers", id];
    const section = tables.get(tomlKey(table));
    if (!section) {
      // 内置 provider（openai 等）：地址不能改，密钥在 auth.json
      return {
        files: [configDisplay, authDisplay],
        configured: true,
        providerId: id,
        baseUrl: readOnly(
          "baseUrl",
          `${configDisplay} → model_provider = "${id}"`,
          serverText("runtimeCredentials.note.builtin"),
        ),
        apiKey: authJson(),
      };
    }
    const where = (key: string) => `${configDisplay} → [model_providers.${id}] ${key}`;
    const entry = (key: string) => section.entries.get(tomlKey([key]))?.value;
    const tomlField = (field: RuntimeCredentialField, key: string): Located => {
      const value = entry(key);
      if (value === "complex") return readOnly(field, where(key), complex);
      return editable(field, value?.value, where(key), {
        file: configFile,
        format: "TOML",
        apply: (content, next) => setTomlString(content, table, key, next),
      });
    };

    const envKey = entry("env_key");
    const requiresAuth = section.entries.get(tomlKey(["requires_openai_auth"]));
    let apiKey: Located;
    if (entry("experimental_bearer_token")) {
      apiKey = tomlField("apiKey", "experimental_bearer_token");
    } else if (envKey) {
      apiKey =
        envKey === "complex"
          ? readOnly("apiKey", where("env_key"), complex)
          : readOnly(
              "apiKey",
              where("env_key"),
              serverText("runtimeCredentials.note.envKey", { name: envKey.value }),
            );
    } else if (
      requiresAuth &&
      /=\s*true\b/.test((configText ?? "").split("\n")[requiresAuth.line] ?? "")
    ) {
      apiKey = authJson();
    } else {
      apiKey = tomlField("apiKey", "experimental_bearer_token");
    }
    return {
      files: [configDisplay, authDisplay],
      configured: true,
      providerId: id,
      baseUrl: tomlField("baseUrl", "base_url"),
      apiKey,
    };
  }

  /** 引用环境变量或别的来源的写法：只读并说明 */
  private reference(
    field: RuntimeCredentialField,
    value: string | undefined,
    location: string,
    patterns: Array<{ match: RegExp; note: (name: string) => ServerText }>,
  ): Located | undefined {
    if (!value) return undefined;
    for (const { match, note } of patterns) {
      const found = match.exec(value);
      if (found) return readOnly(field, location, note(found[1] ?? value));
    }
    return undefined;
  }

  private opencode(pending?: Map<string, string>): Snapshot {
    const file = this.opencodeFile(pending);
    const json = path.join(this.opencodeDir(), "opencode.json");
    const text = this.text(file, pending);
    if (text === undefined) return this.missing(json);
    const data = record(parseJsonc(text));
    const display = this.display(file);
    if (!data) return this.unreadable(file, "JSONC");
    const model = str(data.model);
    const id = providerOf(model);
    if (!id)
      return this.notConfigured([display], serverText("runtimeCredentials.note.noModel"), display);
    if (!record(record(data.provider)?.[id])) {
      return this.notConfigured(
        [display],
        serverText("runtimeCredentials.note.builtinProvider", { model: model! }),
        display,
        id,
      );
    }
    const field = (name: RuntimeCredentialField, key: string): Located => {
      const keys = ["provider", id, "options", key];
      const location = `${display} → provider.${id}.options.${key}`;
      let value: unknown = data;
      for (const part of keys) value = record(value)?.[part];
      // opencode 的变量替换：{env:NAME}、{file:path}
      return (
        this.reference(name, str(value), location, [
          {
            match: /^\{env:([^}]+)\}$/,
            note: (env) => serverText("runtimeCredentials.note.envReference", { name: env }),
          },
          { match: /^\{file:/, note: () => serverText("runtimeCredentials.note.complex") },
        ]) ?? this.jsonField(name, file, data, keys, `provider.${id}.options.${key}`)
      );
    };
    return {
      files: [display],
      configured: true,
      providerId: id,
      baseUrl: field("baseUrl", "baseURL"),
      apiKey: field("apiKey", "apiKey"),
    };
  }

  /** opencode 的全局配置目录：$XDG_CONFIG_HOME/opencode（默认 ~/.config/opencode） */
  opencodeDir(): string {
    return path.join(this.env.XDG_CONFIG_HOME || path.join(this.home, ".config"), "opencode");
  }

  /** opencode.jsonc 优先，没有就是 opencode.json（不存在时也返回它） */
  opencodeFile(pending?: Map<string, string>): string {
    const jsonc = path.join(this.opencodeDir(), "opencode.jsonc");
    return this.text(jsonc, pending) !== undefined
      ? jsonc
      : path.join(this.opencodeDir(), "opencode.json");
  }

  openclawFile(): string {
    return (
      this.env.OPENCLAW_CONFIG_PATH ||
      path.join(this.env.OPENCLAW_STATE_DIR || path.join(this.home, ".openclaw"), "openclaw.json")
    );
  }

  copilotDir(): string {
    return this.env.COPILOT_HOME || path.join(this.home, ".copilot");
  }

  ompAgentDir(): string {
    const root = path.join(this.home, this.env.PI_CONFIG_DIR || ".omp");
    const profile = (this.env.OMP_PROFILE ?? this.env.PI_PROFILE ?? "").trim();
    if (profile && profile !== "default") return path.join(root, "profiles", profile, "agent");
    return this.env.PI_CODING_AGENT_DIR || path.join(root, "agent");
  }

  private omp(pending?: Map<string, string>): Snapshot {
    const dir = this.ompAgentDir();
    const file = path.join(dir, "models.yml");
    const display = this.display(file);
    const text = this.text(file, pending);
    if (text === undefined) return this.missing(file);
    const data = record(parseYaml(text));
    if (!data) return this.unreadable(file, "YAML");
    const config = record(parseYaml(readText(path.join(dir, "config.yml")) ?? ""));
    const model = str(record(config?.modelRoles)?.default);
    const id = providerOf(model);
    if (!id)
      return this.notConfigured([display], serverText("runtimeCredentials.note.noModel"), display);
    const provider = record(record(data.providers)?.[id]);
    if (!provider) {
      return this.notConfigured(
        [display],
        serverText("runtimeCredentials.note.builtinProvider", { model: model! }),
        display,
        id,
      );
    }
    const unsafe = yamlUnsafe(text);
    const field = (name: RuntimeCredentialField): Located => {
      const location = `${display} → providers.${id}.${name}`;
      const value = str(provider[name]);
      if (unsafe) return readOnly(name, location, serverText("runtimeCredentials.note.yamlUnsafe"));
      const reference =
        name === "apiKey"
          ? this.reference(name, value, location, [
              // omp 先把 apiKey 当环境变量名去读；! 开头是 shell 命令
              { match: /^!/, note: () => serverText("runtimeCredentials.note.shellCommand") },
              {
                match: /^([A-Z_][A-Z0-9_]*)$/,
                note: (env) => serverText("runtimeCredentials.note.envReference", { name: env }),
              },
            ])
          : undefined;
      return (
        reference ??
        editable(name, value, location, {
          file,
          format: "YAML",
          apply: (content, next) => setYamlString(content, ["providers", id, name], next),
        })
      );
    };
    return {
      files: [display],
      configured: true,
      providerId: id,
      baseUrl: field("baseUrl"),
      apiKey: field("apiKey"),
    };
  }

  private openclaw(pending?: Map<string, string>): Snapshot {
    const file = this.openclawFile();
    const display = this.display(file);
    const text = this.text(file, pending);
    if (text === undefined) return this.missing(file);
    const data = record(parseJsonc(text));
    // JSON5 特有的写法（不带引号的键、单引号）读不了，也不改
    if (!data) {
      return this.notConfigured(
        [display],
        serverText("runtimeCredentials.note.json5", { file: display }),
        display,
      );
    }
    const defaults = record(record(data.agents)?.defaults);
    const modelSetting = defaults?.model;
    const model = str(record(modelSetting)?.primary) ?? str(modelSetting);
    const id = providerOf(model);
    if (!id)
      return this.notConfigured([display], serverText("runtimeCredentials.note.noModel"), display);
    if (!record(record(record(data.models)?.providers)?.[id])) {
      return this.notConfigured(
        [display],
        serverText("runtimeCredentials.note.builtinProvider", { model: model! }),
        display,
        id,
      );
    }
    const field = (name: RuntimeCredentialField): Located => {
      const keys = ["models", "providers", id, name];
      let value: unknown = data;
      for (const part of keys) value = record(value)?.[part];
      return (
        this.reference(name, str(value), `${display} → models.providers.${id}.${name}`, [
          {
            match: /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/,
            note: (env) => serverText("runtimeCredentials.note.envReference", { name: env }),
          },
        ]) ?? this.jsonField(name, file, data, keys, `models.providers.${id}.${name}`)
      );
    };
    return {
      files: [display],
      configured: true,
      providerId: id,
      baseUrl: field("baseUrl"),
      apiKey: field("apiKey"),
    };
  }

  private copilot(pending?: Map<string, string>): Snapshot {
    const dir = this.copilotDir();
    const file = this.env.COPILOT_PROVIDERS_CONFIG || path.join(dir, "providers.json");
    const display = this.display(file);
    // 设了 COPILOT_PROVIDER_* 时 Copilot 完全不读 providers.json
    const envOverride = COPILOT_PROVIDER_ENV.find((name) => str(this.env[name]));
    const settings = record(parseJsonc(readText(path.join(dir, "settings.json")) ?? ""));
    const model = str(this.env.COPILOT_MODEL) ?? str(settings?.model);
    const id = providerOf(model);
    const text = this.text(file, pending);
    const data = text === undefined ? undefined : record(parseJsonc(text));
    if (text !== undefined && !data) return this.unreadable(file, "JSON");
    const providers = Array.isArray(data?.providers) ? (data.providers as unknown[]) : [];
    const index = id ? providers.findIndex((entry) => record(entry)?.name === id) : -1;
    if (index < 0) {
      return this.notConfigured(
        [display],
        envOverride
          ? serverText("runtimeCredentials.note.envReference", { name: envOverride })
          : serverText("runtimeCredentials.note.copilotOfficial"),
        display,
      );
    }
    const entry = record(providers[index])!;
    const keyName = str(entry.bearerToken) && !str(entry.apiKey) ? "bearerToken" : "apiKey";
    const field = (name: RuntimeCredentialField, key: string) => {
      const result = this.jsonField(
        name,
        file,
        data,
        ["providers", index, key],
        `providers[${id}].${key}`,
      );
      if (envOverride) result.info.shadowedBy = envOverride;
      return result;
    };
    return {
      files: [display],
      configured: true,
      providerId: id!,
      baseUrl: field("baseUrl", "baseUrl"),
      apiKey: field("apiKey", keyName),
    };
  }

  /** 逐个文件备份并原子替换；中途失败把已经换掉的还原回去（配置面板的其它写入也走这里） */
  writeFiles(writes: Write[]) {
    const done: Array<{ target: string; original: string | undefined; mode: number }> = [];
    try {
      for (const { file, content } of writes) {
        const target = resolveTarget(file);
        const original = readText(target);
        const mode = original === undefined ? 0o600 : statSync(target).mode & 0o777;
        if (original !== undefined) this.backup(target);
        this.replace(target, content, mode);
        done.push({ target, original, mode });
      }
    } catch (error) {
      for (const { target, original, mode } of done.reverse()) {
        try {
          if (original === undefined) unlinkSync(target);
          else this.replace(target, original, mode);
        } catch {
          // 还原也失败时备份文件还在，错误照常报出去
        }
      }
      if (error instanceof HiveError) throw error;
      const file = writes[done.length]?.file ?? writes[0]!.file;
      const reason = (error as NodeJS.ErrnoException).code ?? "write error";
      throw new HiveError(
        "RUNTIME_CREDENTIALS_WRITE_FAILED",
        serverText("error.runtimeCredentials.writeFailed", { file: this.display(file), reason }),
      );
    }
  }

  private backup(target: string) {
    const backup = `${target}${BACKUP_TAG}${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`;
    // 备份里也是密钥：不管原文件什么权限，备份只给自己读；同一毫秒内重复备份时覆盖
    const fd = openSync(backup, "w", 0o600);
    try {
      this.writeContent(fd, readFileSync(target, "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(backup, 0o600);
    const dir = path.dirname(target);
    const prefix = `${path.basename(target)}${BACKUP_TAG}`;
    const backups = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort();
    for (const name of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
      try {
        unlinkSync(path.join(dir, name));
      } catch {
        // 清不掉旧备份不影响这次写入
      }
    }
  }

  private replace(target: string, content: string, mode: number) {
    const temp = `${target}.superhive-tmp-${randomBytes(6).toString("hex")}`;
    let fd: number | undefined;
    try {
      // 目标 CLI 还没建过配置目录（例如从没打开过 opencode）时先建上，目录权限和 CLI 自己建的一样只给本人
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fd = openSync(temp, "wx", mode);
      this.writeContent(fd, content);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, target);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        // 临时文件可能还没建出来
      }
      throw error;
    }
  }
}

/** 配置文件是符号链接（比如放在 dotfiles 仓库里）时写到链接指向的文件，链接本身保留 */
function resolveTarget(file: string): string {
  try {
    if (lstatSync(file).isSymbolicLink()) return realpathSync(file);
  } catch {
    // 文件还不存在
  }
  return file;
}
