import { createHash } from "node:crypto";
import path from "node:path";
import { readFileSync } from "node:fs";
import { stringify as stringifyToml } from "smol-toml";
import {
  serverText,
  zhText,
  type RuntimeConfig,
  type RuntimeConfigField,
  type RuntimeConfigFile,
  type RuntimeCredentialProvider,
  type RuntimeMcpServer,
  type RuntimeMcpServerInput,
  type ServerText,
} from "@superhive/protocol";
import {
  appendToml,
  parseJsonc,
  parseToml,
  parseYaml,
  removeTomlTable,
  setJsoncValue,
  setTomlValue,
  setYamlString,
  yamlUnsafe,
} from "./config-edit.js";
import { HiveError } from "./database.js";
import type { RuntimeCredentialContext, RuntimeCredentialStore } from "./runtime-credentials.js";
import { RUNTIME_LABELS } from "./runtime-skills.js";

/**
 * Agent CLI 的配置面板（只限本机房主）：接入地址与密钥仍由 RuntimeCredentialStore 负责，这里补上
 * - 附加项与常用行为：模型、推理强度、审批与沙箱等，只收语义确定的几项，值写在 CLI 自己的全局配置里；
 * - 全局 MCP 服务器：增删改，CLI 支持时可单独停用；
 * - 全局提示词文件（CLAUDE.md、AGENTS.md…）；
 * - 原始配置文件：整份查看与编辑，语法校验通过才保存。
 * 读写位置参照 cc-switch 对各 CLI 的处理。只改目标键、保留注释与格式；读不懂的写法只读并说明原因。
 * 写入沿用 RuntimeCredentialStore 的备份、原子替换和失败回滚；整份写入时带打开时的哈希，期间被改过就拒绝。
 */

type Format = "json" | "jsonc" | "toml" | "yaml";

type FieldSpec = {
  id: string;
  group: "access" | "behavior";
  kind: "text" | "select" | "boolean";
  options?: string[];
  file: string;
  format: Format;
  /** JSON：键路径；TOML：表路径 + 键；YAML：映射键路径 */
  path: string[];
  note?: ServerText;
  /** 只读：CLI 自己管这个文件（例如 omp 的 config.yml 带锁文件），cc-switch 也不写 */
  readOnly?: ServerText;
  /** 写之前的额外校验，例如 opencode 的模型必须是 provider/model */
  pattern?: RegExp;
};

type McpKind = "mcpServers" | "opencode" | "codex";

type McpSpec = {
  file: string;
  format: Format;
  kind: McpKind;
  /**
   * mcpServers 风格怎么单独停用：enabled=条目里写 enabled:false（omp 还同步顶层 disabledServers 名单）；
   * list=写进另一个文件里的停用名单（Copilot 的 settings.json disabledMcpServers）；没有就不能停用
   */
  toggle?: { kind: "enabled"; disabledList?: string } | { kind: "list"; file: string; key: string };
  /** stdio 条目的 type 写什么（Copilot 用 local）；不写就保留原样 */
  stdioType?: string;
  /** 新建条目时补的默认字段（Copilot 的 tools: ["*"]） */
  defaults?: Record<string, unknown>;
};

type Spec = {
  fields: FieldSpec[];
  mcp?: McpSpec;
  /** 不支持 MCP 时的原因 */
  mcpNote?: ServerText;
  prompt?: string;
  raw: Array<{ id: string; file: string; format: Format }>;
};

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const CODEX_REASONING = ["minimal", "low", "medium", "high", "xhigh"];
/** codex 0.162 起 approval_policy="untrusted" 不再被接受，不提供 */
export const CODEX_APPROVAL = ["on-request", "on-failure", "never"];
export const CODEX_SANDBOX = ["read-only", "workspace-write", "danger-full-access"];
export const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];

export function contentHash(content: string | undefined): string | null {
  return content === undefined ? null : createHash("sha256").update(content).digest("hex");
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

function at(data: unknown, keys: string[]): unknown {
  let value = data;
  for (const key of keys) value = record(value)?.[key];
  return value;
}

/** 整份解析；读不懂时返回 undefined */
export function parseFormat(format: Format, content: string): Record<string, unknown> | undefined {
  if (format === "toml") return content.trim() ? parseToml(content) : {};
  if (format === "yaml") return record(parseYaml(content)) ?? (content.trim() ? undefined : {});
  return record(parseJsonc(content));
}

function invalid(reason: string): HiveError {
  return new HiveError(
    "RUNTIME_CONFIG_INVALID",
    serverText("error.runtimeConfig.invalid", { reason }),
  );
}

export class RuntimeConfigStore {
  constructor(private readonly credentials: RuntimeCredentialStore) {}

  private display(file: string) {
    return this.credentials.display(file);
  }

  /** 各运行时的配置项、MCP、提示词和原始文件在哪里 */
  private spec(provider: RuntimeCredentialProvider): Spec {
    const c = this.credentials;
    const terminalOnly = serverText("runtimeConfig.note.terminalOnly");
    switch (provider) {
      case "claude": {
        const settings = path.join(c.claudeDir, "settings.json");
        const env = (id: string, name: string): FieldSpec => ({
          id,
          group: "access",
          kind: "text",
          file: settings,
          format: "json",
          path: ["env", name],
        });
        return {
          fields: [
            env("model", "ANTHROPIC_MODEL"),
            env("fableModel", "ANTHROPIC_DEFAULT_FABLE_MODEL"),
            env("opusModel", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
            env("sonnetModel", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
            env("haikuModel", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
            env("subagentModel", "CLAUDE_CODE_SUBAGENT_MODEL"),
            {
              id: "permissionMode",
              group: "behavior",
              kind: "select",
              options: CLAUDE_PERMISSION_MODES,
              file: settings,
              format: "json",
              path: ["permissions", "defaultMode"],
              note: terminalOnly,
            },
          ],
          // 全局 MCP 在 ~/.claude.json（Claude Code 自己也频繁写这个文件，只改 mcpServers 下的那一项）
          mcp: {
            file: path.join(path.dirname(c.claudeDir), ".claude.json"),
            format: "json",
            kind: "mcpServers",
          },
          prompt: path.join(c.claudeDir, "CLAUDE.md"),
          raw: [{ id: "settings", file: settings, format: "json" }],
        };
      }
      case "codex": {
        const config = path.join(c.codexHome, "config.toml");
        const providerId = this.codexProvider(config);
        const root = (
          id: string,
          group: FieldSpec["group"],
          kind: FieldSpec["kind"],
          options?: string[],
          note?: ServerText,
        ): FieldSpec => ({
          id,
          group,
          kind,
          ...(options ? { options } : {}),
          file: config,
          format: "toml",
          path: [id],
          ...(note ? { note } : {}),
        });
        const fields: FieldSpec[] = [
          root("model", "access", "text"),
          root("model_provider", "access", "text"),
          root("model_reasoning_effort", "access", "select", CODEX_REASONING),
          root("approval_policy", "behavior", "select", CODEX_APPROVAL, terminalOnly),
          root("sandbox_mode", "behavior", "select", CODEX_SANDBOX, terminalOnly),
        ];
        if (providerId) {
          fields.splice(2, 0, {
            id: "wire_api",
            group: "access",
            kind: "select",
            options: ["responses", "chat"],
            file: config,
            format: "toml",
            path: ["model_providers", providerId, "wire_api"],
          });
        }
        return {
          fields,
          mcp: { file: config, format: "toml", kind: "codex" },
          prompt: path.join(c.codexHome, "AGENTS.md"),
          raw: [
            { id: "config", file: config, format: "toml" },
            { id: "auth", file: path.join(c.codexHome, "auth.json"), format: "json" },
          ],
        };
      }
      case "opencode": {
        const file = c.opencodeFile();
        const format: Format = file.endsWith(".jsonc") ? "jsonc" : "json";
        return {
          fields: [
            {
              id: "model",
              group: "access",
              kind: "text",
              file,
              format,
              path: ["model"],
              pattern: /^[^/\s]+\/\S+$/,
            },
            {
              id: "small_model",
              group: "access",
              kind: "text",
              file,
              format,
              path: ["small_model"],
              pattern: /^[^/\s]+\/\S+$/,
            },
          ],
          mcp: { file, format, kind: "opencode" },
          prompt: path.join(c.opencodeDir(), "AGENTS.md"),
          raw: [{ id: "config", file, format }],
        };
      }
      case "omp": {
        const dir = c.ompAgentDir();
        const config = path.join(dir, "config.yml");
        return {
          fields: [
            {
              id: "model",
              group: "access",
              kind: "text",
              file: config,
              format: "yaml",
              path: ["modelRoles", "default"],
              readOnly: serverText("runtimeConfig.note.ompOwned"),
            },
          ],
          mcp: {
            file: path.join(dir, "mcp.json"),
            format: "json",
            kind: "mcpServers",
            toggle: { kind: "enabled", disabledList: "disabledServers" },
          },
          prompt: path.join(dir, "AGENTS.md"),
          raw: [
            { id: "config", file: config, format: "yaml" },
            { id: "models", file: path.join(dir, "models.yml"), format: "yaml" },
            { id: "mcp", file: path.join(dir, "mcp.json"), format: "json" },
          ],
        };
      }
      case "openclaw": {
        const file = c.openclawFile();
        return {
          fields: [
            {
              id: "model",
              group: "access",
              kind: "text",
              file,
              format: "json",
              path: ["agents", "defaults", "model", "primary"],
            },
            {
              id: "toolsProfile",
              group: "behavior",
              kind: "select",
              options: ["minimal", "coding", "messaging", "full"],
              file,
              format: "json",
              path: ["tools", "profile"],
            },
          ],
          mcpNote: serverText("runtimeConfig.note.mcpUnsupported", { name: "OpenClaw" }),
          // OpenClaw 从 Agent 工作区读 AGENTS.md：agents.defaults.workspace，默认 ~/.openclaw/workspace
          prompt: this.openclawWorkspacePrompt(file),
          raw: [{ id: "config", file, format: "json" }],
        };
      }
      case "copilot": {
        const dir = c.copilotDir();
        const settings = path.join(dir, "settings.json");
        const mcp = path.join(dir, "mcp-config.json");
        return {
          fields: [
            {
              id: "model",
              group: "access",
              kind: "text",
              file: settings,
              format: "jsonc",
              path: ["model"],
            },
          ],
          mcp: {
            file: mcp,
            format: "json",
            kind: "mcpServers",
            toggle: { kind: "list", file: settings, key: "disabledMcpServers" },
            stdioType: "local",
            defaults: { tools: ["*"] },
          },
          prompt: path.join(dir, "copilot-instructions.md"),
          raw: [
            { id: "settings", file: settings, format: "jsonc" },
            {
              id: "providers",
              file: c.env.COPILOT_PROVIDERS_CONFIG || path.join(dir, "providers.json"),
              format: "json",
            },
            { id: "mcp", file: mcp, format: "json" },
          ],
        };
      }
    }
  }

  private openclawWorkspacePrompt(file: string): string {
    const workspace = at(parseJsonc(readText(file) ?? ""), ["agents", "defaults", "workspace"]);
    const dir =
      typeof workspace === "string" && workspace.trim()
        ? workspace.replace(/^~(?=$|\/)/, this.credentials.home)
        : path.join(path.dirname(file), "workspace");
    return path.join(dir, "AGENTS.md");
  }

  private codexProvider(config: string): string | undefined {
    const value = parseToml(readText(config) ?? "")?.model_provider;
    return typeof value === "string" && value && value !== "openai" ? value : undefined;
  }

  get(provider: RuntimeCredentialProvider, context: RuntimeCredentialContext = {}): RuntimeConfig {
    const spec = this.spec(provider);
    return {
      provider,
      credentials: this.credentials.get(provider, context),
      fields: spec.fields.map((field) => this.readField(provider, field)),
      mcp: this.readMcp(spec),
      prompt: spec.prompt ? this.fileInfo("prompt", spec.prompt, "markdown") : null,
      rawFiles: spec.raw.map((raw) => this.fileInfo(raw.id, raw.file, raw.format)),
    };
  }

  private fileInfo(id: string, file: string, format: RuntimeConfigFile["format"]) {
    return { id, path: this.display(file), format, exists: readText(file) !== undefined };
  }

  private readField(provider: RuntimeCredentialProvider, spec: FieldSpec): RuntimeConfigField {
    const location = `${this.display(spec.file)} → ${spec.path.join(".")}`;
    const text = readText(spec.file);
    const data = parseFormat(spec.format, text ?? "");
    const base = {
      id: spec.id,
      group: spec.group,
      kind: spec.kind,
      ...(spec.options ? { options: spec.options } : {}),
      location,
    };
    const withNote = (note: ServerText | undefined) =>
      note ? { note: zhText(note), noteText: note } : {};
    if (!data) {
      const note = serverText("runtimeCredentials.note.complex");
      return { ...base, value: null, editable: false, ...withNote(note) };
    }
    const raw = at(data, spec.path);
    const value =
      spec.kind === "boolean"
        ? typeof raw === "boolean"
          ? raw
          : null
        : typeof raw === "string"
          ? raw
          : null;
    // 值是认不出的类型（数组、对象…），或 YAML 用了锚点等写法：只读
    const unreadable =
      (raw !== undefined && value === null) || (spec.format === "yaml" && yamlUnsafe(text ?? ""));
    const missingParent =
      spec.format === "yaml" && text === undefined
        ? serverText("runtimeCredentials.note.missing", { file: this.display(spec.file) })
        : undefined;
    const note = unreadable ? serverText("runtimeCredentials.note.complex") : spec.note;
    void provider;
    return {
      ...base,
      value,
      editable: !unreadable && !missingParent && !spec.readOnly,
      ...withNote(spec.readOnly ?? missingParent ?? note),
    };
  }

  /** 改附加项与行为设置：同一文件的多项一起写一次；null 表示删掉回到默认 */
  updateFields(
    provider: RuntimeCredentialProvider,
    values: Record<string, string | boolean | null>,
  ): string[] {
    const spec = this.spec(provider);
    const pending = new Map<string, string>();
    const changed: string[] = [];
    for (const [id, value] of Object.entries(values)) {
      const field = spec.fields.find((item) => item.id === id);
      if (!field) throw invalid(id);
      const info = this.readField(provider, field);
      if (!info.editable) {
        throw new HiveError(
          "RUNTIME_CREDENTIALS_NOT_EDITABLE",
          serverText("error.runtimeCredentials.notEditable", {
            field: id,
            reason: info.noteText ?? serverText("runtimeCredentials.note.complex"),
          }),
        );
      }
      if (value !== null) {
        if (field.kind === "boolean" ? typeof value !== "boolean" : typeof value !== "string") {
          throw invalid(id);
        }
        if (field.kind === "select" && !field.options!.includes(value as string)) {
          throw invalid(id);
        }
        if (typeof value === "string" && (!value.trim() || /[\r\n]/.test(value))) {
          throw invalid(id);
        }
        if (field.pattern && typeof value === "string" && !field.pattern.test(value)) {
          throw invalid(id);
        }
      }
      const current = pending.get(field.file) ?? readText(field.file) ?? "";
      pending.set(field.file, this.setValue(field, current, value));
      changed.push(id);
    }
    this.credentials.writeFiles([...pending].map(([file, content]) => ({ file, content })));
    return changed;
  }

  private setValue(field: FieldSpec, content: string, value: string | boolean | null): string {
    try {
      if (field.format === "toml") {
        return setTomlValue(
          content,
          field.path.slice(0, -1),
          field.path.at(-1)!,
          value === null ? undefined : value,
        );
      }
      if (field.format === "yaml") {
        if (value === null || typeof value !== "string") throw new Error("yaml");
        return setYamlString(content, field.path, value);
      }
      return setJsoncValue(content, field.path, value === null ? undefined : value);
    } catch {
      throw new HiveError(
        "RUNTIME_CREDENTIALS_UNREADABLE",
        serverText("error.runtimeCredentials.unreadable", {
          file: this.display(field.file),
          reason: field.format.toUpperCase(),
        }),
      );
    }
  }

  /* ---------- MCP ---------- */

  private readMcp(spec: Spec): RuntimeConfig["mcp"] {
    if (!spec.mcp) {
      const note = spec.mcpNote ?? serverText("runtimeCredentials.note.complex");
      return {
        supported: false,
        file: "",
        canToggle: false,
        servers: [],
        note: zhText(note),
        noteText: note,
      };
    }
    const { file, format, kind } = spec.mcp;
    const text = readText(file) ?? "";
    const data = parseFormat(format, text);
    const base = {
      file: this.display(file),
      canToggle: kind !== "mcpServers" || Boolean(spec.mcp.toggle),
    };
    if (!data) {
      const note = serverText("runtimeCredentials.note.complex");
      return {
        ...base,
        supported: false,
        servers: [],
        note: zhText(note),
        noteText: note,
      };
    }
    const servers = Object.entries(record(data[this.mcpRoot(kind)]) ?? {}).flatMap(
      ([name, value]) => {
        const entry = record(value);
        return entry ? [this.toServer(kind, name, entry, spec.mcp!)] : [];
      },
    );
    return { ...base, supported: true, servers };
  }

  private mcpRoot(kind: McpKind) {
    return kind === "opencode" ? "mcp" : kind === "codex" ? "mcp_servers" : "mcpServers";
  }

  private toServer(
    kind: McpKind,
    name: string,
    entry: Record<string, unknown>,
    spec: McpSpec,
  ): RuntimeMcpServer {
    const strings = (value: unknown) =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const keys = (value: unknown) => Object.keys(record(value) ?? {});
    if (kind === "opencode") {
      const command = strings(entry.command);
      const remote = entry.type === "remote";
      return {
        name,
        transport: remote ? "http" : "stdio",
        ...(remote
          ? { url: String(entry.url ?? "") }
          : { command: command[0] ?? "", args: command.slice(1) }),
        envKeys: keys(entry.environment),
        enabled: entry.enabled !== false,
      };
    }
    const url = typeof entry.url === "string" ? entry.url : undefined;
    const type = entry.type;
    const transport =
      type === "sse"
        ? "sse"
        : url || type === "http" || type === "streamable-http"
          ? "http"
          : "stdio";
    const enabled =
      spec.toggle?.kind === "list"
        ? !this.disabledList(spec).includes(name)
        : entry.enabled !== false;
    return {
      name,
      transport,
      ...(transport === "stdio"
        ? { command: String(entry.command ?? ""), args: strings(entry.args) }
        : { url: url ?? "" }),
      envKeys: keys(entry.env),
      enabled,
    };
  }

  /** 总览用：只读 MCP 列表，不碰密钥 */
  mcpOf(provider: RuntimeCredentialProvider): RuntimeConfig["mcp"] {
    return this.readMcp(this.spec(provider));
  }

  /**
   * 把一个 MCP 原样（含环境变量的值、远程的请求头）复制到别的运行时；目标里已有同名的就整体拒绝，不覆盖。
   * 只搬各 CLI 都能表达的字段：stdio 的 command/args/env，远程的 url 和写死值的请求头
   * （Claude/Copilot/omp/opencode 写 headers，Codex 写 http_headers）。其余字段（Codex 的
   * bearer_token_env_var、cwd、超时，Copilot 限定的 tools 等）以及引用环境变量的值（`${X}`、
   * `{env:X}`，各 CLI 写法不同）转不过去，整体拒绝并列出字段，免得复制出一份少了认证、连不上的配置
   */
  syncMcp(
    provider: RuntimeCredentialProvider,
    name: string,
    targets: RuntimeCredentialProvider[],
  ): RuntimeCredentialProvider[] {
    const spec = this.requireMcp(provider);
    const data = parseFormat(spec.format, readText(spec.file) ?? "");
    if (!data) throw this.mcpUnreadable(spec.file, spec.format);
    const entry = record(record(data[this.mcpRoot(spec.kind)])?.[name]);
    if (!entry) throw invalid(name);
    const list = [...new Set(targets)].filter((target) => target !== provider);
    if (!list.length) throw invalid("targets");
    const server = this.toServer(spec.kind, name, entry, spec);
    const stdio = server.transport === "stdio";
    const envKey = spec.kind === "opencode" ? "environment" : "env";
    const headerKey = spec.kind === "codex" ? "http_headers" : "headers";
    const blocked: string[] = [];
    const known = new Set([
      "command",
      "args",
      "url",
      "enabled",
      envKey,
      headerKey,
      ...(spec.kind === "codex" ? [] : ["type"]),
    ]);
    for (const key of Object.keys(entry)) {
      // Copilot 新建条目默认写 tools: ["*"]（全部工具），这个值各 CLI 都等于不写
      const allTools =
        key === "tools" &&
        Array.isArray(entry.tools) &&
        entry.tools.length === 1 &&
        entry.tools[0] === "*";
      if (!known.has(key) && !allTools) blocked.push(key);
    }
    const strings = (key: string) => {
      const value = entry[key];
      if (value === undefined) return {};
      const map = record(value);
      if (!map || Object.values(map).some((item) => typeof item !== "string")) {
        blocked.push(key);
        return {};
      }
      return map as Record<string, string>;
    };
    const env = strings(envKey);
    const headers = stdio ? {} : strings(headerKey);
    if (stdio && entry[headerKey] !== undefined) blocked.push(headerKey);
    // 引用环境变量的写法各家不同（Claude `${X}`、opencode `{env:X}`、Codex 不展开），原样搬过去会变成字面量
    const refers = (value: string) => /\$\{|\{env:|^\$[A-Za-z_]/.test(value);
    const values: [string, string][] = [
      ["url", server.url ?? ""],
      ["command", server.command ?? ""],
      ...(server.args ?? []).map((arg, index): [string, string] => [`args[${index}]`, arg]),
      ...Object.entries(env).map(([key, value]): [string, string] => [`${envKey}.${key}`, value]),
      ...Object.entries(headers).map(([key, value]): [string, string] => [
        `${headerKey}.${key}`,
        value,
      ]),
    ];
    for (const [field, value] of values) if (refers(value)) blocked.push(field);
    if (blocked.length) {
      throw new HiveError(
        "RUNTIME_CREDENTIALS_NOT_EDITABLE",
        serverText("error.runtimeSkills.mcpNotPortable", {
          name,
          fields: [...new Set(blocked)].join("、"),
          target: list.map((target) => RUNTIME_LABELS[target]).join("、"),
        }),
      );
    }
    const input: RuntimeMcpServerInput = {
      transport: server.transport,
      ...(stdio
        ? { command: server.command ?? "", args: server.args ?? [] }
        : { url: server.url ?? "" }),
      env,
      enabled: true,
    };
    if (stdio ? !input.command : !input.url) throw invalid(name);
    this.addMcp(list, name, input, Object.keys(headers).length ? headers : undefined);
    return list;
  }

  /** 一次写进多个运行时：先全部检查（支持 MCP、没有同名），再逐个写 */
  addMcp(
    targets: RuntimeCredentialProvider[],
    name: string,
    input: RuntimeMcpServerInput,
    headers?: Record<string, string>,
  ) {
    const list = [...new Set(targets)];
    for (const target of list) this.preflightMcp(target, name);
    for (const target of list) this.putMcp(target, name, input, undefined, headers);
  }

  /**
   * 新增前的检查：支持全局 MCP、读得懂、没有同名。不通过就抛错；通过时返回配置文件（家目录写成 ~）
   * 和当前内容的哈希，安装计划靠它判断预览之后文件有没有被改过
   */
  preflightMcp(
    target: RuntimeCredentialProvider,
    name: string,
  ): { file: string; hash: string | null } {
    const spec = this.spec(target);
    const mcp = this.readMcp(spec);
    if (!mcp.supported || !spec.mcp) {
      throw new HiveError(
        "RUNTIME_CREDENTIALS_NOT_EDITABLE",
        serverText("error.runtimeCredentials.notEditable", {
          field: "MCP",
          reason: mcp.noteText ?? serverText("runtimeCredentials.note.complex"),
        }),
      );
    }
    if (mcp.servers.some((item) => item.name === name)) {
      throw new HiveError(
        "RUNTIME_SKILL_EXISTS",
        serverText("error.runtimeSkills.exists", { target: RUNTIME_LABELS[target], name }),
      );
    }
    return { file: mcp.file, hash: this.mcpFileHash(target) };
  }

  /** MCP 配置文件当前内容的哈希；文件还不存在时为 null */
  mcpFileHash(target: RuntimeCredentialProvider): string | null {
    const spec = this.spec(target).mcp;
    return spec ? contentHash(readText(spec.file)) : null;
  }

  /**
   * 新增或修改一个 MCP；改名时先删旧的。没写的字段（例如 headers、timeout）保留原值。
   * headers 只给远程的用，按目标的写法落盘（Codex 是 http_headers，其余是 headers）
   */
  putMcp(
    provider: RuntimeCredentialProvider,
    name: string,
    server: RuntimeMcpServerInput,
    previousName?: string,
    headers?: Record<string, string>,
  ) {
    const spec = this.requireMcp(provider);
    const { file, format, kind } = spec;
    let content = readText(file) ?? "";
    const data = parseFormat(format, content);
    if (!data) throw this.mcpUnreadable(file, format);
    const servers = record(data[this.mcpRoot(kind)]) ?? {};
    const oldName = previousName ?? name;
    if (previousName && previousName !== name && servers[name]) throw invalid(name);
    const existing = record(servers[oldName]) ?? {};
    const entry = this.toEntry(kind, server, existing, spec);
    if (headers && server.transport !== "stdio") {
      entry[kind === "codex" ? "http_headers" : "headers"] = headers;
    }
    try {
      if (kind === "codex") {
        if (servers[oldName]) content = removeTomlTable(content, ["mcp_servers", oldName]);
        content = appendToml(
          content,
          stringifyToml({ mcp_servers: { [name]: entry } } as Record<string, unknown>),
        );
      } else {
        if (previousName && previousName !== name && servers[previousName]) {
          content = setJsoncValue(content, [this.mcpRoot(kind), previousName], undefined);
        }
        content = setJsoncValue(content, [this.mcpRoot(kind), name], entry);
      }
    } catch (error) {
      if (error instanceof HiveError) throw error;
      throw this.mcpUnreadable(file, format);
    }
    this.credentials.writeFiles([{ file, content }]);
  }

  deleteMcp(provider: RuntimeCredentialProvider, name: string) {
    const { file, format, kind } = this.requireMcp(provider);
    let content = readText(file) ?? "";
    const data = parseFormat(format, content);
    if (!data) throw this.mcpUnreadable(file, format);
    if (!record(data[this.mcpRoot(kind)])?.[name]) throw invalid(name);
    try {
      content =
        kind === "codex"
          ? removeTomlTable(content, ["mcp_servers", name])
          : setJsoncValue(content, [this.mcpRoot(kind), name], undefined);
    } catch {
      throw this.mcpUnreadable(file, format);
    }
    this.credentials.writeFiles([{ file, content }]);
  }

  toggleMcp(provider: RuntimeCredentialProvider, name: string, enabled: boolean) {
    const spec = this.requireMcp(provider);
    const { file, format, kind } = spec;
    if (kind === "mcpServers" && !spec.toggle) {
      throw new HiveError(
        "RUNTIME_CREDENTIALS_NOT_EDITABLE",
        serverText("error.runtimeCredentials.notEditable", {
          field: name,
          reason: serverText("runtimeConfig.note.noToggle"),
        }),
      );
    }
    let content = readText(file) ?? "";
    const data = parseFormat(format, content);
    if (!data) throw this.mcpUnreadable(file, format);
    if (!record(data[this.mcpRoot(kind)])?.[name]) throw invalid(name);
    const toggle = spec.toggle;
    if (toggle?.kind === "list") {
      // Copilot：停用名单在 settings.json 里，mcp-config.json 不动
      const list = this.disabledList(spec).filter((item) => item !== name);
      if (!enabled) list.push(name);
      let settings = readText(toggle.file) ?? "";
      try {
        settings = setJsoncValue(settings, [toggle.key], list.length ? list : undefined);
      } catch {
        throw this.mcpUnreadable(toggle.file, "jsonc");
      }
      this.credentials.writeFiles([{ file: toggle.file, content: settings }]);
      return;
    }
    try {
      if (kind === "codex") {
        // 启用就删掉 enabled = false，回到默认
        content = setTomlValue(
          content,
          ["mcp_servers", name],
          "enabled",
          enabled ? undefined : false,
        );
      } else {
        content = setJsoncValue(
          content,
          [this.mcpRoot(kind), name, "enabled"],
          kind === "opencode" ? enabled : enabled ? undefined : false,
        );
        if (toggle?.kind === "enabled" && toggle.disabledList) {
          content = this.syncDisabledList(content, toggle.disabledList, name, enabled);
        }
      }
    } catch {
      throw this.mcpUnreadable(file, format);
    }
    this.credentials.writeFiles([{ file, content }]);
  }

  /** omp：停用的名字同步进顶层 disabledServers，并从 enabledServers 里拿掉 */
  private syncDisabledList(content: string, key: string, name: string, enabled: boolean): string {
    const data = record(parseJsonc(content)) ?? {};
    const names = (value: unknown) =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const disabled = names(data[key]).filter((item) => item !== name);
    if (!enabled) disabled.push(name);
    let next = setJsoncValue(content, [key], disabled.length ? disabled : undefined);
    const enabledList = names(data.enabledServers);
    if (!enabled && enabledList.includes(name)) {
      const rest = enabledList.filter((item) => item !== name);
      next = setJsoncValue(next, ["enabledServers"], rest.length ? rest : undefined);
    }
    return next;
  }

  private disabledList(spec: McpSpec): string[] {
    if (spec.toggle?.kind !== "list") return [];
    const value = at(parseJsonc(readText(spec.toggle.file) ?? ""), [spec.toggle.key]);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }

  private requireMcp(provider: RuntimeCredentialProvider): McpSpec {
    const spec = this.spec(provider);
    if (!spec.mcp) {
      throw new HiveError(
        "RUNTIME_CREDENTIALS_NOT_EDITABLE",
        serverText("error.runtimeCredentials.notEditable", {
          field: "MCP",
          reason: spec.mcpNote ?? serverText("runtimeCredentials.note.complex"),
        }),
      );
    }
    return spec.mcp;
  }

  private mcpUnreadable(file: string, format: Format) {
    return new HiveError(
      "RUNTIME_CREDENTIALS_UNREADABLE",
      serverText("error.runtimeCredentials.unreadable", {
        file: this.display(file),
        reason: format.toUpperCase(),
      }),
    );
  }

  /** 按各 CLI 的写法生成一项；env 里值为 null 的沿用原来的值 */
  private toEntry(
    kind: McpKind,
    server: RuntimeMcpServerInput,
    existing: Record<string, unknown>,
    spec: McpSpec,
  ): Record<string, unknown> {
    const envKey = kind === "opencode" ? "environment" : "env";
    const oldEnv = record(existing[envKey]) ?? {};
    const env = server.env
      ? Object.fromEntries(
          Object.entries(server.env).flatMap(([key, value]) => {
            const kept = value ?? oldEnv[key];
            return typeof kept === "string" ? [[key, kept]] : [];
          }),
        )
      : oldEnv;
    const isNew = Object.keys(existing).length === 0;
    // 在原条目上就地改：键的顺序不变，原来就有的空 args / env 也保留
    const entry: Record<string, unknown> = { ...(isNew ? (spec.defaults ?? {}) : existing) };
    const set = (key: string, value: unknown) => {
      if (value === undefined) delete entry[key];
      else entry[key] = value;
    };
    const stdio = server.transport === "stdio";
    // 换了传输方式就去掉对方专属的字段，否则 Codex 等会拒绝加载整份配置
    for (const key of stdio
      ? ["url", "headers", "http_headers", "bearer_token_env_var"]
      : ["command", "args", "cwd"]) {
      delete entry[key];
    }
    const keepEnv = Object.keys(env).length > 0 || envKey in existing;
    if (kind === "opencode") {
      if (stdio) {
        set("type", "local");
        set("command", [server.command!, ...(server.args ?? [])]);
      } else {
        set("type", "remote");
        set("url", server.url!);
      }
      set("environment", keepEnv ? env : undefined);
      set("enabled", server.enabled ?? existing.enabled !== false);
      return entry;
    }
    if (stdio) {
      set("command", server.command!);
      set("args", server.args?.length || "args" in existing ? (server.args ?? []) : undefined);
      if (kind === "mcpServers") {
        set("type", spec.stdioType ?? ("type" in existing ? "stdio" : undefined));
      }
    } else {
      set("url", server.url!);
      if (kind === "mcpServers") set("type", server.transport);
    }
    set(envKey, keepEnv ? env : undefined);
    if (server.enabled !== undefined && spec.toggle?.kind !== "list") {
      if (server.enabled) {
        if (entry.enabled === false) delete entry.enabled;
      } else if (kind === "codex" || spec.toggle?.kind === "enabled") entry.enabled = false;
    }
    return entry;
  }

  /* ---------- 整份文件：提示词与原始配置 ---------- */

  private fileSpec(provider: RuntimeCredentialProvider, id: string) {
    const spec = this.spec(provider);
    if (id === "prompt" && spec.prompt) return { file: spec.prompt, format: "markdown" as const };
    const raw = spec.raw.find((item) => item.id === id);
    if (!raw) throw invalid(id);
    return raw;
  }

  /** 原文与哈希；原始配置里有密钥，调用方在确认后才取 */
  readFile(provider: RuntimeCredentialProvider, id: string) {
    const { file } = this.fileSpec(provider, id);
    const content = readText(file);
    if (content !== undefined && Buffer.byteLength(content) > MAX_FILE_BYTES) throw invalid(id);
    return { content: content ?? "", hash: contentHash(content), exists: content !== undefined };
  }

  /** 整份写回：语法校验通过、且打开后没被改过才写 */
  writeFile(
    provider: RuntimeCredentialProvider,
    id: string,
    content: string,
    baseHash: string | null,
  ) {
    const { file, format } = this.fileSpec(provider, id);
    const current = readText(file);
    if (contentHash(current) !== baseHash) {
      throw new HiveError(
        "RUNTIME_CONFIG_CHANGED",
        serverText("error.runtimeConfig.changed", { file: this.display(file) }),
      );
    }
    if (format !== "markdown") {
      if (!parseFormat(format, content)) throw invalid(format.toUpperCase());
      if (format === "json" && content.trim()) {
        try {
          JSON.parse(content);
        } catch {
          throw invalid("JSON");
        }
      }
    }
    this.credentials.writeFiles([{ file, content }]);
    return { hash: contentHash(content) };
  }
}
