import {
  cpSync,
  lstatSync,
  readlinkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  serverText,
  zhText,
  type RuntimeCredentialProvider,
  type RuntimeSkill,
  type RuntimeSkillSource,
  type RuntimeSkills,
  type ServerText,
} from "@superhive/protocol";
import { appendToml, parseJsonc, parseToml, parseYaml, setJsoncValue } from "./config-edit.js";
import { HiveError } from "./database.js";
import {
  RUNTIME_CREDENTIAL_PROVIDERS,
  type RuntimeCredentialStore,
} from "./runtime-credentials.js";

/**
 * 各 Agent CLI 的全局 skills（只限本机房主）。调研记录见 docs/research/global-skills.md。
 *
 * - 列出：每个运行时会读的全局目录里，带 SKILL.md 的子目录（软链也算），名称、描述取 frontmatter；
 * - 启停：只用各运行时原生的开关，写在 CLI 自己的配置里，不挪目录：
 *   Claude Code settings.json 的 skillOverrides、Codex config.toml 的 [[skills.config]]、
 *   opencode 的 permission.skill、Copilot settings.json 的 disabledSkills、OpenClaw 的 skills.entries；
 *   omp 的 skills.ignoredSkills 在它自己管理的 config.yml 里，只读；
 * - 删除：把 skill 目录（或软链本身）挪进同级的 .superhive-skill-backups/，不真删，可以挪回来；
 * - 同步：把目录复制到另一个运行时自己的 skills 目录（软链会展开成实际文件）。
 * Hive 自带的 superhive skill（带 hive 的托管标记）只读；插件带的跟着插件启停，只读。
 * 配置写入沿用 RuntimeCredentialStore 的备份和原子替换。
 */

const BACKUP_DIR = ".superhive-skill-backups";
const MAX_SKILL_BYTES = 1024 * 1024;
/** hive skill install 写进 SKILL.md 的托管标记 */
const SUPERHIVE_MARKER = /id=superhive version=/;

export const RUNTIME_LABELS: Record<RuntimeCredentialProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  omp: "omp",
  openclaw: "OpenClaw",
  copilot: "Copilot CLI",
};

type Root = {
  /** 在 skill id 里用的目录来源名 */
  key: string;
  dir: string;
  source: Exclude<RuntimeSkillSource, "superhive">;
  plugin?: { id: string; name: string; enabled: boolean };
  /** 跳过的子目录名（Codex 的 .system 单独作为一个来源） */
  skip?: string[];
};

type Toggle =
  | { kind: "claude"; file: string }
  | { kind: "codex"; file: string }
  | { kind: "opencode"; file: string }
  | { kind: "list"; file: string; key: string[] }
  | { kind: "openclaw"; file: string }
  | { kind: "omp"; file: string };

type Spec = {
  roots: Root[];
  toggle: Toggle;
  /** 同步过来时放哪里 */
  primary: string;
  /** 启停认的名字：frontmatter 的 name，opencode 认目录名 */
  keyBy: "name" | "dir";
  note?: ServerText;
};

type Found = {
  root: Root;
  dirName: string;
  dir: string;
  skillMd: string;
  name: string;
  description: string;
  superhive: boolean;
  linkTarget?: string;
};

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function isDir(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** SKILL.md 开头的 YAML frontmatter：name、description */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return {};
  let data: Record<string, unknown> | undefined;
  try {
    data = record(parseYaml(match[1]!));
  } catch {
    return {};
  }
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  return {
    ...(text(data?.name) ? { name: text(data?.name)! } : {}),
    ...(text(data?.description) ? { description: text(data?.description)! } : {}),
  };
}

/** glob 里只认 *（opencode、omp 的规则写法） */
function globMatch(pattern: string, value: string): boolean {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${source}$`).test(value);
}

function invalid(reason: string): HiveError {
  return new HiveError(
    "RUNTIME_CONFIG_INVALID",
    serverText("error.runtimeConfig.invalid", { reason }),
  );
}

function notEditable(field: string, reason: ServerText): HiveError {
  return new HiveError(
    "RUNTIME_CREDENTIALS_NOT_EDITABLE",
    serverText("error.runtimeCredentials.notEditable", { field, reason }),
  );
}

const CODEX_SKILL_HEADER = /^\s*\[\[\s*skills\s*\.\s*config\s*\]\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[/;

/**
 * Codex：删掉 config.toml 里认这个 skill 的 [[skills.config]] 段（按 name 或 path），停用时在末尾追加
 * `name = "…"`、`enabled = false` 一段。写法认不出（例如内联数组）时抛错，由调用方当只读处理。
 */
export function setCodexSkillEnabled(
  content: string,
  matches: (entry: Record<string, unknown>) => boolean,
  name: string,
  enabled: boolean,
): string {
  const before = parseToml(content);
  if (!before) throw new Error("invalid TOML");
  const entriesOf = (data: Record<string, unknown>) =>
    (Array.isArray(record(data.skills)?.config) ? (record(data.skills)!.config as unknown[]) : [])
      .map(record)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const matching = entriesOf(before).filter(matches).length;
  const lines = content.split("\n");
  const keep: string[] = [];
  let dropped = 0;
  for (let index = 0; index < lines.length;) {
    if (!CODEX_SKILL_HEADER.test(lines[index]!)) {
      keep.push(lines[index]!);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !ANY_HEADER.test(lines[end]!)) end += 1;
    const body = parseToml(lines.slice(index + 1, end).join("\n"));
    if (body && matches(body)) {
      dropped += 1;
    } else {
      keep.push(...lines.slice(index, end));
    }
    index = end;
  }
  if (dropped !== matching) throw new Error("unrecognized skills.config layout");
  let next = keep.join("\n").replace(/\n{3,}/g, "\n\n");
  if (!enabled) {
    next = appendToml(next, `[[skills.config]]\nname = ${JSON.stringify(name)}\nenabled = false`);
  }
  const after = parseToml(next);
  if (!after) throw new Error("invalid TOML");
  const expected = entriesOf(before).length - matching + (enabled ? 0 : 1);
  if (entriesOf(after).length !== expected) throw new Error("edit mismatch");
  return next;
}

export class RuntimeSkillStore {
  constructor(private readonly credentials: RuntimeCredentialStore) {}

  private display(file: string) {
    return this.credentials.display(file);
  }

  private yamlFile(file: string): Record<string, unknown> {
    try {
      return record(parseYaml(readText(file) ?? "")) ?? {};
    } catch {
      return {};
    }
  }

  private jsonFile(file: string): Record<string, unknown> | undefined {
    const text = readText(file);
    if (text === undefined || !text.trim()) return {};
    return record(parseJsonc(text));
  }

  /** 这个运行时的配置目录在不在（用来决定总览里出不出现） */
  installed(provider: RuntimeCredentialProvider): boolean {
    const c = this.credentials;
    switch (provider) {
      case "claude":
        return isDir(c.claudeDir);
      case "codex":
        return isDir(c.codexHome);
      case "opencode":
        return isDir(c.opencodeDir());
      case "omp":
        return isDir(c.ompAgentDir());
      case "openclaw":
        return isDir(path.dirname(c.openclawFile()));
      case "copilot":
        return isDir(c.copilotDir());
    }
  }

  private spec(provider: RuntimeCredentialProvider): Spec {
    const c = this.credentials;
    const agents = path.join(c.home, ".agents", "skills");
    const claudeUser = path.join(c.claudeDir, "skills");
    switch (provider) {
      case "claude":
        return {
          roots: [{ key: "user", dir: claudeUser, source: "user" }, ...this.claudePluginRoots()],
          toggle: { kind: "claude", file: path.join(c.claudeDir, "settings.json") },
          primary: claudeUser,
          keyBy: "name",
        };
      case "codex": {
        const user = path.join(c.codexHome, "skills");
        return {
          roots: [
            { key: "user", dir: user, source: "user", skip: [".system"] },
            { key: "agents", dir: agents, source: "shared" },
            { key: "system", dir: path.join(user, ".system"), source: "system" },
          ],
          toggle: { kind: "codex", file: path.join(c.codexHome, "config.toml") },
          primary: user,
          keyBy: "name",
        };
      }
      case "opencode": {
        const dir = c.opencodeDir();
        return {
          roots: [
            { key: "user", dir: path.join(dir, "skills"), source: "user" },
            { key: "user-legacy", dir: path.join(dir, "skill"), source: "user" },
            { key: "claude", dir: claudeUser, source: "shared" },
            { key: "agents", dir: agents, source: "shared" },
          ],
          toggle: { kind: "opencode", file: c.opencodeFile() },
          primary: path.join(dir, "skills"),
          keyBy: "dir",
        };
      }
      case "omp": {
        const dir = c.ompAgentDir();
        const config = path.join(dir, "config.yml");
        const skills = record(this.yamlFile(config).skills) ?? {};
        const flag = (key: string, fallback: boolean) =>
          typeof skills[key] === "boolean" ? (skills[key] as boolean) : fallback;
        const roots: Root[] = [];
        if (flag("enablePiUser", true)) {
          roots.push({ key: "user", dir: path.join(dir, "skills"), source: "user" });
        }
        if (flag("enableAgentsUser", true)) {
          roots.push({ key: "agents", dir: agents, source: "shared" });
        }
        if (flag("enableClaudeUser", false)) {
          roots.push({ key: "claude", dir: claudeUser, source: "shared" });
        }
        if (flag("enableCodexUser", false)) {
          roots.push({
            key: "codex",
            dir: path.join(c.codexHome, "skills"),
            source: "shared",
            skip: [".system"],
          });
        }
        return {
          roots,
          toggle: { kind: "omp", file: config },
          primary: path.join(dir, "skills"),
          keyBy: "name",
          note: serverText("runtimeSkills.note.ompOwned"),
        };
      }
      case "openclaw": {
        const file = c.openclawFile();
        const workspace = record(record(record(this.jsonFile(file))?.agents)?.defaults)?.workspace;
        const workspaceDir =
          typeof workspace === "string" && workspace.trim()
            ? workspace.replace(/^~(?=$|\/)/, c.home)
            : path.join(path.dirname(file), "workspace");
        const managed = path.join(path.dirname(file), "skills");
        return {
          roots: [
            { key: "user", dir: managed, source: "user" },
            { key: "workspace", dir: path.join(workspaceDir, "skills"), source: "user" },
          ],
          toggle: { kind: "openclaw", file },
          primary: managed,
          keyBy: "name",
          note: serverText("runtimeSkills.note.unverified", { name: "OpenClaw" }),
        };
      }
      case "copilot": {
        const dir = c.copilotDir();
        return {
          roots: [
            { key: "user", dir: path.join(dir, "skills"), source: "user" },
            { key: "agents", dir: agents, source: "shared" },
          ],
          toggle: { kind: "list", file: path.join(dir, "settings.json"), key: ["disabledSkills"] },
          primary: path.join(dir, "skills"),
          keyBy: "name",
        };
      }
    }
  }

  /** Claude Code 插件带的 skills：plugins/installed_plugins.json 里每个插件安装目录下的 skills/ */
  private claudePluginRoots(): Root[] {
    const dir = this.credentials.claudeDir;
    const installed = record(this.jsonFile(path.join(dir, "plugins", "installed_plugins.json")));
    const enabled = record(this.jsonFile(path.join(dir, "settings.json"))?.enabledPlugins) ?? {};
    const roots: Root[] = [];
    for (const [id, value] of Object.entries(record(installed?.plugins) ?? {})) {
      const install = (Array.isArray(value) ? value : [value])
        .map(record)
        .find((item) => typeof item?.installPath === "string");
      if (!install) continue;
      const name = id.split("@")[0] || id;
      roots.push({
        key: `plugin:${id}`,
        dir: path.join(install.installPath as string, "skills"),
        source: "plugin",
        plugin: { id, name, enabled: enabled[id] === true },
      });
    }
    return roots;
  }

  private scan(root: Root): Found[] {
    let names: string[];
    try {
      names = readdirSync(root.dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => !name.startsWith(".") && !root.skip?.includes(name))
      .sort()
      .flatMap((dirName) => {
        const dir = path.join(root.dir, dirName);
        const skillMd = path.join(dir, "SKILL.md");
        if (!isDir(dir)) return [];
        const content = readText(skillMd);
        if (content === undefined) return [];
        const front = parseSkillFrontmatter(content);
        let linkTarget: string | undefined;
        try {
          if (lstatSync(dir).isSymbolicLink()) {
            linkTarget = this.display(path.resolve(root.dir, readlinkSync(dir)));
          }
        } catch {
          // 读不到软链目标不影响列出
        }
        const baseName = front.name ?? dirName;
        return [
          {
            root,
            dirName,
            dir,
            skillMd,
            name: root.plugin ? `${root.plugin.name}:${baseName}` : baseName,
            description: front.description ?? "",
            superhive: SUPERHIVE_MARKER.test(content),
            ...(linkTarget ? { linkTarget } : {}),
          },
        ];
      });
  }

  /** 各运行时会读到这个目录的（按真实路径比） */
  private sharedWith(dir: string, self: RuntimeCredentialProvider): RuntimeCredentialProvider[] {
    const real = (file: string) => {
      try {
        return realpathSync(file);
      } catch {
        return path.resolve(file);
      }
    };
    const target = real(dir);
    return RUNTIME_CREDENTIAL_PROVIDERS.filter(
      (provider) =>
        provider !== self &&
        this.installed(provider) &&
        this.spec(provider).roots.some(
          (root) => root.source !== "plugin" && real(root.dir) === target,
        ),
    );
  }

  /* ---------- 启停状态 ---------- */

  private toggleKey(spec: Spec, found: Found) {
    return spec.keyBy === "dir" ? found.dirName : found.name;
  }

  /** 读开关：返回判断函数；配置读不懂时 unreadable 带原因 */
  private toggleState(spec: Spec): {
    enabled: (key: string, found: Found) => boolean;
    unreadable?: ServerText;
  } {
    const toggle = spec.toggle;
    const unreadable = serverText("runtimeSkills.note.unreadable", {
      file: this.display(toggle.file),
    });
    switch (toggle.kind) {
      case "claude": {
        const data = this.jsonFile(toggle.file);
        if (!data) return { enabled: () => true, unreadable };
        const overrides = record(data.skillOverrides) ?? {};
        return { enabled: (key) => overrides[key] !== "off" };
      }
      case "codex": {
        const data = parseToml(readText(toggle.file) ?? "");
        if (!data) return { enabled: () => true, unreadable };
        const entries = this.codexEntries(data);
        return {
          enabled: (key, found) => {
            const hit = entries.filter((entry) => this.codexMatches(entry, key, found));
            return hit.length === 0 || hit.at(-1)!.enabled !== false;
          },
        };
      }
      case "opencode": {
        const data = this.jsonFile(toggle.file);
        if (!data || (data.permission !== undefined && !record(data.permission))) {
          return { enabled: () => true, unreadable };
        }
        const rule = record(data.permission)?.skill;
        return { enabled: (key) => this.opencodeAction(rule, key) !== "deny" };
      }
      case "list": {
        const data = this.jsonFile(toggle.file);
        if (!data) return { enabled: () => true, unreadable };
        const list = strings(data[toggle.key[0]!]).map((item) => item.toLowerCase());
        return { enabled: (key) => !list.includes(key.toLowerCase()) };
      }
      case "openclaw": {
        const data = this.jsonFile(toggle.file);
        if (!data) return { enabled: () => true, unreadable };
        const entries = record(record(data.skills)?.entries) ?? {};
        return { enabled: (key) => record(entries[key])?.enabled !== false };
      }
      case "omp": {
        const skills = record(this.yamlFile(toggle.file).skills) ?? {};
        const all = skills.enabled !== false;
        const ignored = strings(skills.ignoredSkills);
        const include = strings(skills.includeSkills);
        return {
          enabled: (key) =>
            all &&
            !ignored.some((pattern) => globMatch(pattern, key)) &&
            (include.length === 0 || include.some((pattern) => globMatch(pattern, key))),
        };
      }
    }
  }

  private codexEntries(data: Record<string, unknown>) {
    const config = record(data.skills)?.config;
    return (Array.isArray(config) ? config : [])
      .map(record)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  }

  private codexMatches(entry: Record<string, unknown>, key: string, found: Found) {
    if (typeof entry.name === "string") return entry.name === key;
    if (typeof entry.path !== "string") return false;
    const target = path.resolve(entry.path.replace(/^~(?=$|\/)/, this.credentials.home));
    return target === found.skillMd || target === found.dir;
  }

  /** opencode 的 permission.skill：字符串对全部生效；对象按顺序、最后命中的规则为准 */
  private opencodeAction(rule: unknown, key: string): string {
    if (typeof rule === "string") return rule;
    let action = "allow";
    for (const [pattern, value] of Object.entries(record(rule) ?? {})) {
      if (typeof value === "string" && globMatch(pattern, key)) action = value;
    }
    return action;
  }

  /* ---------- 列出 ---------- */

  private findAll(provider: RuntimeCredentialProvider): { spec: Spec; found: Found[] } {
    const spec = this.spec(provider);
    return { spec, found: spec.roots.flatMap((root) => this.scan(root)) };
  }

  list(provider: RuntimeCredentialProvider): RuntimeSkills {
    const { spec, found } = this.findAll(provider);
    const state = this.toggleState(spec);
    const canToggleRuntime = spec.toggle.kind !== "omp" && !state.unreadable;
    const label = RUNTIME_LABELS[provider];
    const skills = found.map((item): RuntimeSkill => {
      const source: RuntimeSkillSource = item.superhive ? "superhive" : item.root.source;
      const pluginEnabled = item.root.plugin ? item.root.plugin.enabled : true;
      const reason: ServerText | undefined =
        source === "superhive"
          ? serverText("runtimeSkills.note.superhive")
          : item.root.plugin
            ? serverText("runtimeSkills.note.plugin", { plugin: item.root.plugin.name })
            : source === "system"
              ? serverText("runtimeSkills.note.system", { name: label })
              : !canToggleRuntime
                ? (state.unreadable ?? spec.note)
                : undefined;
      return {
        id: `${item.root.key}/${item.dirName}`,
        name: item.name,
        description: item.description,
        source,
        ...(item.root.plugin ? { plugin: item.root.plugin.name } : {}),
        path: this.display(item.dir),
        ...(item.linkTarget ? { linkTarget: item.linkTarget } : {}),
        enabled: pluginEnabled && state.enabled(this.toggleKey(spec, item), item),
        canToggle: canToggleRuntime && source !== "superhive" && source !== "plugin",
        canDelete: source === "user" || source === "shared",
        canSync: source === "user" || source === "shared",
        sharedWith: source === "plugin" ? [] : this.sharedWith(item.root.dir, provider),
        ...(reason ? { note: zhText(reason), noteText: reason } : {}),
      };
    });
    const note = state.unreadable ?? spec.note;
    return {
      provider,
      ...(canToggleRuntime ? { toggleLocation: this.display(spec.toggle.file) } : {}),
      dirs: spec.roots
        .filter((root) => root.source !== "plugin")
        .map((root) => ({
          path: this.display(root.dir),
          exists: isDir(root.dir),
          source: root.source,
        })),
      skills,
      ...(note ? { note: zhText(note), noteText: note } : {}),
    };
  }

  private require(provider: RuntimeCredentialProvider, id: string) {
    const { spec, found } = this.findAll(provider);
    const item = found.find((entry) => `${entry.root.key}/${entry.dirName}` === id);
    if (!item) {
      throw new HiveError("RUNTIME_SKILL_NOT_FOUND", serverText("error.runtimeSkills.notFound"));
    }
    const info = this.list(provider).skills.find((skill) => skill.id === id)!;
    return { spec, item, info };
  }

  /** SKILL.md 原文 */
  read(provider: RuntimeCredentialProvider, id: string) {
    const { item } = this.require(provider, id);
    const content = readText(item.skillMd) ?? "";
    if (Buffer.byteLength(content) > MAX_SKILL_BYTES) throw invalid("SKILL.md > 1 MB");
    return { content, path: this.display(item.skillMd) };
  }

  /* ---------- 启停 ---------- */

  toggle(provider: RuntimeCredentialProvider, id: string, enabled: boolean) {
    const { spec, item, info } = this.require(provider, id);
    if (!info.canToggle) {
      throw notEditable(
        info.name,
        (info.noteText as ServerText | undefined) ?? serverText("runtimeCredentials.note.complex"),
      );
    }
    const key = this.toggleKey(spec, item);
    const toggle = spec.toggle;
    const content = readText(toggle.file) ?? "";
    const unreadable = () =>
      notEditable(
        info.name,
        serverText("runtimeSkills.note.unreadable", { file: this.display(toggle.file) }),
      );
    let next: string;
    try {
      next = this.nextContent(toggle, content, key, item, enabled);
    } catch {
      throw unreadable();
    }
    if (next !== content) this.credentials.writeFiles([{ file: toggle.file, content: next }]);
  }

  private nextContent(
    toggle: Toggle,
    content: string,
    key: string,
    item: Found,
    enabled: boolean,
  ): string {
    switch (toggle.kind) {
      case "claude":
        return setJsoncValue(content, ["skillOverrides", key], enabled ? undefined : "off");
      case "codex":
        return setCodexSkillEnabled(
          content,
          (entry) => this.codexMatches(entry, key, item),
          key,
          enabled,
        );
      case "opencode": {
        const data = record(parseJsonc(content || "{}"))!;
        const rule = record(data.permission)?.skill;
        if (typeof rule === "string") {
          if ((rule === "deny") === !enabled) return content;
          return setJsoncValue(content, ["permission", "skill"], {
            "*": rule,
            [key]: enabled ? "allow" : "deny",
          });
        }
        let next = content;
        if (record(rule)?.[key] !== undefined) {
          next = setJsoncValue(next, ["permission", "skill", key], undefined);
        }
        const after = record(record(record(parseJsonc(next || "{}"))?.permission)?.skill);
        const denied = this.opencodeAction(after, key) === "deny";
        if (enabled && denied) next = setJsoncValue(next, ["permission", "skill", key], "allow");
        if (!enabled && !denied) next = setJsoncValue(next, ["permission", "skill", key], "deny");
        return next;
      }
      case "list": {
        const data = record(parseJsonc(content || "{}"))!;
        const list = strings(data[toggle.key[0]!]).filter(
          (name) => name.toLowerCase() !== key.toLowerCase(),
        );
        if (!enabled) list.push(key);
        return setJsoncValue(content, toggle.key, list.length ? list : undefined);
      }
      case "openclaw":
        return setJsoncValue(
          content,
          ["skills", "entries", key, "enabled"],
          enabled ? undefined : false,
        );
      case "omp":
        throw new Error("omp owns config.yml");
    }
  }

  /* ---------- 删除：挪进备份目录 ---------- */

  remove(provider: RuntimeCredentialProvider, id: string): { backup: string } {
    const { item, info } = this.require(provider, id);
    if (!info.canDelete) {
      throw notEditable(
        info.name,
        (info.noteText as ServerText | undefined) ?? serverText("runtimeCredentials.note.complex"),
      );
    }
    const backups = path.join(path.dirname(item.root.dir), BACKUP_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(backups, `${item.dirName}-${stamp}-${randomBytes(3).toString("hex")}`);
    try {
      mkdirSync(backups, { recursive: true, mode: 0o700 });
      // 软链只挪链接本身，指向的目录不动
      renameSync(item.dir, target);
    } catch (error) {
      throw new HiveError(
        "RUNTIME_CREDENTIALS_WRITE_FAILED",
        serverText("error.runtimeSkills.moveFailed", {
          path: this.display(item.dir),
          reason: (error as NodeJS.ErrnoException).code ?? "error",
        }),
      );
    }
    return { backup: this.display(target) };
  }

  /* ---------- 同步：复制到别的运行时 ---------- */

  /** 某个运行时里有没有这个名字的 skill（同步前排除已经有的） */
  has(provider: RuntimeCredentialProvider, name: string): boolean {
    return this.findAll(provider).found.some((item) => item.name === name);
  }

  sync(provider: RuntimeCredentialProvider, id: string, targets: RuntimeCredentialProvider[]) {
    const { item, info } = this.require(provider, id);
    if (!info.canSync) {
      throw notEditable(
        info.name,
        (info.noteText as ServerText | undefined) ?? serverText("runtimeCredentials.note.complex"),
      );
    }
    const plan = [...new Set(targets)]
      .filter((target) => target !== provider)
      .map((target) => {
        const dir = path.join(this.spec(target).primary, item.dirName);
        if (
          this.has(target, item.name) ||
          readText(path.join(dir, "SKILL.md")) !== undefined ||
          isDir(dir)
        ) {
          throw new HiveError(
            "RUNTIME_SKILL_EXISTS",
            serverText("error.runtimeSkills.exists", {
              target: RUNTIME_LABELS[target],
              name: item.name,
            }),
          );
        }
        return { target, dir };
      });
    if (!plan.length) throw invalid("targets");
    const done: string[] = [];
    try {
      for (const { dir } of plan) {
        mkdirSync(path.dirname(dir), { recursive: true });
        // 先复制到临时目录再改名，中途失败不会留下半个 skill
        const temp = `${dir}.superhive-tmp-${randomBytes(6).toString("hex")}`;
        try {
          cpSync(item.dir, temp, { recursive: true, dereference: true, errorOnExist: true });
          renameSync(temp, dir);
        } finally {
          rmSync(temp, { recursive: true, force: true });
        }
        done.push(dir);
      }
    } catch (error) {
      for (const dir of done) rmSync(dir, { recursive: true, force: true });
      if (error instanceof HiveError) throw error;
      throw new HiveError(
        "RUNTIME_CREDENTIALS_WRITE_FAILED",
        serverText("error.runtimeSkills.moveFailed", {
          path: this.display(item.dir),
          reason: (error as NodeJS.ErrnoException).code ?? "error",
        }),
      );
    }
    return plan.map(({ target, dir }) => ({ provider: target, path: this.display(dir) }));
  }
}
