import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { SpawnAgent } from "./local-agents.js";
import { RuntimeConfigStore } from "./runtime-config.js";
import { RuntimeCredentialStore } from "./runtime-credentials.js";
import {
  parseSkillFrontmatter,
  RuntimeSkillStore,
  setCodexSkillEnabled,
} from "./runtime-skills.js";

/** 全部在临时 HOME 里，不碰真实的 ~/.claude、~/.codex 等 */
let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function setup() {
  const home = mkdtempSync(path.join(tmpdir(), "hive-skills-"));
  dirs.push(home);
  const claudeDir = path.join(home, ".claude");
  const codexHome = path.join(home, ".codex");
  mkdirSync(claudeDir);
  mkdirSync(codexHome);
  const credentials = new RuntimeCredentialStore({
    home,
    env: {},
    claudeDir,
    codexHome,
    claudeManagedSettings: path.join(home, "managed.json"),
  });
  return {
    home,
    claudeDir,
    codexHome,
    credentials,
    skills: new RuntimeSkillStore(credentials),
    config: new RuntimeConfigStore(credentials),
  };
}

function skill(dir: string, name: string, description = `${name} 的说明`, extra = "") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n${extra}`,
  );
}

const read = (file: string) => readFileSync(file, "utf8");

describe("parseSkillFrontmatter", () => {
  it("reads name and description, and tolerates missing or broken frontmatter", () => {
    expect(
      parseSkillFrontmatter("---\nname: a\ndescription: >\n  多行\n  说明\n---\nbody"),
    ).toEqual({
      name: "a",
      description: "多行 说明",
    });
    expect(parseSkillFrontmatter("# no frontmatter")).toEqual({});
    expect(parseSkillFrontmatter("---\nname: [oops\n---\n")).toEqual({});
  });
});

describe("RuntimeSkillStore · Claude Code", () => {
  it("lists user, plugin and superhive skills and toggles with skillOverrides", () => {
    const { claudeDir, skills } = setup();
    skill(path.join(claudeDir, "skills", "pdf"), "pdf");
    skill(
      path.join(claudeDir, "skills", "superhive"),
      "superhive",
      "加入 Hive",
      "<!-- 由 hive 安装并管理：id=superhive version=0.4.8；请勿手改 -->\n",
    );
    const pluginDir = path.join(claudeDir, "plugins", "cache", "m", "figma", "1.0.0");
    skill(path.join(pluginDir, "skills", "figma-use"), "figma-use");
    writeFileSync(
      path.join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "figma@m": [{ installPath: pluginDir }] } }),
    );
    const settings = path.join(claudeDir, "settings.json");
    writeFileSync(settings, `{\n  // 注释保留\n  "enabledPlugins": { "figma@m": false }\n}\n`);

    const list = skills.list("claude");
    expect(list.toggleLocation).toBe("~/.claude/settings.json");
    const byName = Object.fromEntries(list.skills.map((item) => [item.name, item]));
    expect(byName.pdf).toMatchObject({
      id: "user/pdf",
      source: "user",
      description: "pdf 的说明",
      enabled: true,
      canToggle: true,
      canDelete: true,
      canSync: true,
    });
    expect(byName.superhive).toMatchObject({
      source: "superhive",
      canToggle: false,
      canDelete: false,
      canSync: false,
    });
    expect(byName.superhive!.note).toContain("superhive");
    expect(byName["figma:figma-use"]).toMatchObject({
      source: "plugin",
      plugin: "figma",
      enabled: false,
      canToggle: false,
      canDelete: false,
    });

    skills.toggle("claude", "user/pdf", false);
    expect(read(settings)).toContain("// 注释保留");
    expect(JSON.parse(read(settings).replace(/\/\/.*\n/, "")).skillOverrides).toEqual({
      pdf: "off",
    });
    expect(readdirSync(claudeDir).some((name) => name.startsWith("settings.json.superhive"))).toBe(
      true,
    );
    expect(skills.list("claude").skills.find((item) => item.name === "pdf")?.enabled).toBe(false);
    skills.toggle("claude", "user/pdf", true);
    expect(read(settings)).not.toContain('"pdf"');

    expect(() => skills.toggle("claude", "user/superhive", false)).toThrow(/superhive/);
    expect(() => skills.remove("claude", "user/superhive")).toThrow(/superhive/);
    expect(() => skills.toggle("claude", "plugin:figma@m/figma-use", true)).toThrow(/plugin/);
  });

  it("deletes by moving the folder into a backup directory, and only the link for symlinks", () => {
    const { home, claudeDir, skills } = setup();
    skill(path.join(claudeDir, "skills", "pdf"), "pdf");
    const shared = path.join(home, "elsewhere", "herdr");
    skill(shared, "herdr");
    symlinkSync(shared, path.join(claudeDir, "skills", "herdr"));

    expect(skills.list("claude").skills.find((item) => item.name === "herdr")?.linkTarget).toBe(
      "~/elsewhere/herdr",
    );
    const { backup } = skills.remove("claude", "user/pdf");
    expect(backup).toMatch(/^~\/\.claude\/\.superhive-skill-backups\/pdf-/);
    expect(existsSync(path.join(claudeDir, "skills", "pdf"))).toBe(false);
    expect(read(path.join(home, backup.slice(2), "SKILL.md"))).toContain("name: pdf");

    skills.remove("claude", "user/herdr");
    expect(existsSync(path.join(claudeDir, "skills", "herdr"))).toBe(false);
    expect(existsSync(path.join(shared, "SKILL.md"))).toBe(true);
    expect(() => skills.remove("claude", "user/pdf")).toThrow(/找不到/);
  });
});

describe("RuntimeSkillStore · Codex", () => {
  it("toggles with [[skills.config]], keeps the rest of config.toml, and protects system skills", () => {
    const { home, codexHome, skills } = setup();
    skill(path.join(codexHome, "skills", "web"), "web");
    skill(path.join(codexHome, "skills", ".system", "skill-creator"), "skill-creator");
    skill(path.join(home, ".agents", "skills", "lark"), "lark");
    const file = path.join(codexHome, "config.toml");
    const original = `# 主配置\nmodel = "gpt-5"\n\n[[skills.config]]\nname = "other"\nenabled = false\n\n[mcp_servers.x]\ncommand = "x"\n`;
    writeFileSync(file, original);

    const list = skills.list("codex");
    expect(list.skills.map((item) => [item.id, item.source])).toEqual([
      ["user/web", "user"],
      ["agents/lark", "shared"],
      ["system/skill-creator", "system"],
    ]);
    const system = list.skills.find((item) => item.source === "system")!;
    expect(system).toMatchObject({ canToggle: true, canDelete: false, canSync: false });

    skills.toggle("codex", "user/web", false);
    expect(read(file)).toContain('[[skills.config]]\nname = "web"\nenabled = false\n');
    expect(read(file)).toContain('name = "other"');
    expect(read(file)).toContain("# 主配置");
    expect(skills.list("codex").skills.find((item) => item.name === "web")?.enabled).toBe(false);
    skills.toggle("codex", "user/web", true);
    expect(read(file)).not.toContain('"web"');
    expect(read(file)).toContain('name = "other"');
    expect(read(file)).toContain("[mcp_servers.x]");

    // 按 path 停用的也认，启用时一起去掉
    writeFileSync(
      file,
      `[[skills.config]]\npath = "${path.join(codexHome, "skills", ".system", "skill-creator", "SKILL.md")}"\nenabled = false\n`,
    );
    expect(skills.list("codex").skills.find((item) => item.source === "system")?.enabled).toBe(
      false,
    );
    skills.toggle("codex", "system/skill-creator", true);
    expect(read(file)).not.toContain("skills.config");
  });

  it("refuses to edit an inline skills.config it can't safely rewrite", () => {
    const inline = `skills = { config = [{ name = "web", enabled = false }] }\n`;
    expect(() =>
      setCodexSkillEnabled(inline, (entry) => entry.name === "web", "web", true),
    ).toThrow();
  });

  it("marks a shared ~/.agents/skills folder with the other runtimes that read it", () => {
    const { home, skills } = setup();
    skill(path.join(home, ".agents", "skills", "lark"), "lark");
    mkdirSync(path.join(home, ".copilot"));
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    const lark = skills.list("codex").skills[0]!;
    expect(lark.sharedWith.sort()).toEqual(["copilot", "opencode"]);
  });
});

describe("RuntimeSkillStore · other runtimes", () => {
  it("opencode denies by folder id under permission.skill", () => {
    const { home, skills } = setup();
    const dir = path.join(home, ".config", "opencode");
    skill(path.join(dir, "skills", "release"), "Git Release");
    const file = path.join(dir, "opencode.json");
    writeFileSync(file, `{\n  "permission": { "skill": "allow" }\n}\n`);

    skills.toggle("opencode", "user/release", false);
    expect(JSON.parse(read(file)).permission.skill).toEqual({ "*": "allow", release: "deny" });
    expect(skills.list("opencode").skills[0]?.enabled).toBe(false);
    skills.toggle("opencode", "user/release", true);
    expect(JSON.parse(read(file)).permission.skill).toEqual({ "*": "allow" });

    writeFileSync(file, `{ "permission": { "skill": { "*": "deny" } } }`);
    expect(skills.list("opencode").skills[0]?.enabled).toBe(false);
    skills.toggle("opencode", "user/release", true);
    expect(JSON.parse(read(file)).permission.skill).toEqual({ "*": "deny", release: "allow" });
  });

  it("Copilot uses disabledSkills (any case), OpenClaw uses skills.entries", () => {
    const { home, skills } = setup();
    skill(path.join(home, ".copilot", "skills", "Review"), "Review");
    const settings = path.join(home, ".copilot", "settings.json");
    writeFileSync(settings, `{ "disabledSkills": ["review"] }`);
    expect(skills.list("copilot").skills[0]?.enabled).toBe(false);
    skills.toggle("copilot", "user/Review", true);
    expect(JSON.parse(read(settings)).disabledSkills).toBeUndefined();
    skills.toggle("copilot", "user/Review", false);
    expect(JSON.parse(read(settings)).disabledSkills).toEqual(["Review"]);

    skill(path.join(home, ".openclaw", "skills", "weather"), "weather");
    const claw = path.join(home, ".openclaw", "openclaw.json");
    skills.toggle("openclaw", "user/weather", false);
    expect(JSON.parse(read(claw)).skills.entries.weather.enabled).toBe(false);
    expect(skills.list("openclaw").note).toContain("文档");
  });

  it("omp is read-only and follows skills.ignoredSkills in its own config.yml", () => {
    const { home, skills } = setup();
    const dir = path.join(home, ".omp", "agent");
    skill(path.join(dir, "skills", "git-flow"), "git-flow");
    writeFileSync(path.join(dir, "config.yml"), "skills:\n  ignoredSkills:\n    - git-*\n");
    const list = skills.list("omp");
    expect(list.toggleLocation).toBeUndefined();
    expect(list.skills[0]).toMatchObject({ enabled: false, canToggle: false, canDelete: true });
    expect(list.note).toContain("omp config set");
    expect(() => skills.toggle("omp", "user/git-flow", true)).toThrow();
  });
});

describe("sync", () => {
  it("copies a skill into another runtime's own folder, resolving symlinks, and never overwrites", () => {
    const { home, claudeDir, codexHome, skills } = setup();
    const real = path.join(home, "src", "pdf");
    skill(real, "pdf");
    writeFileSync(path.join(real, "helper.py"), "print(1)\n");
    mkdirSync(path.join(claudeDir, "skills"));
    symlinkSync(real, path.join(claudeDir, "skills", "pdf"));

    skills.sync("claude", "user/pdf", ["codex"]);
    expect(read(path.join(codexHome, "skills", "pdf", "helper.py"))).toBe("print(1)\n");
    expect(skills.has("codex", "pdf")).toBe(true);
    expect(() => skills.sync("claude", "user/pdf", ["codex"])).toThrow(/已经有/);
  });

  it("copies an MCP server with its environment values", () => {
    const { home, codexHome, config } = setup();
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { docs: { command: "npx", args: ["docs-mcp"], env: { TOKEN: "t-1" } } },
      }),
    );
    config.syncMcp("claude", "docs", ["codex"]);
    const toml = read(path.join(codexHome, "config.toml"));
    expect(toml).toContain("[mcp_servers.docs]");
    expect(toml).toContain('TOKEN = "t-1"');
    expect(() => config.syncMcp("claude", "docs", ["codex"])).toThrow(/已经有/);
  });
});

describe("routes", () => {
  it("only the local owner can list, read, toggle, delete and see the overview", async () => {
    const { home, claudeDir, credentials } = setup();
    skill(path.join(claudeDir, "skills", "pdf"), "pdf");
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { docs: { command: "npx", env: { TOKEN: "secret-1" } } } }),
    );
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      runtimeCredentials: credentials,
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        spawn: vi.fn<SpawnAgent>(),
        probe: async () => ({ installed: true, version: "1.0.0" }),
      },
    });
    try {
      const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
        ownerToken: string;
      };
      const owner = { "x-hive-owner": session.ownerToken };

      const list = await app.inject({
        method: "GET",
        url: "/api/local/runtime-skills/claude",
        headers: owner,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().skills.skills[0].name).toBe("pdf");

      const file = await app.inject({
        method: "POST",
        url: `/api/local/runtime-skills/claude/${encodeURIComponent("user/pdf")}/read`,
        headers: owner,
      });
      expect(file.json().content).toContain("name: pdf");
      expect(file.headers["cache-control"]).toBe("no-store");

      const toggle = await app.inject({
        method: "POST",
        url: `/api/local/runtime-skills/claude/${encodeURIComponent("user/pdf")}/toggle`,
        headers: owner,
        payload: { enabled: false },
      });
      expect(toggle.json().skills.skills[0].enabled).toBe(false);

      const overview = await app.inject({
        method: "GET",
        url: "/api/local/runtime-overview",
        headers: owner,
      });
      const body = overview.json().overview;
      expect(body.providers.map((item: { provider: string }) => item.provider)).toEqual([
        "claude",
        "codex",
      ]);
      expect(body.mcp).toEqual([
        { name: "docs", entries: [{ provider: "claude", enabled: true, transport: "stdio" }] },
      ]);
      expect(body.skills[0]).toMatchObject({
        name: "pdf",
        entries: [{ provider: "claude", enabled: false }],
      });
      expect(overview.body).not.toContain("secret-1");

      const sync = await app.inject({
        method: "POST",
        url: "/api/local/runtime-config/claude/mcp/docs/sync",
        headers: owner,
        payload: { targets: ["codex"] },
      });
      expect(sync.statusCode).toBe(200);
      expect(sync.body).not.toContain("secret-1");
      expect(sync.json().overview.mcp[0].entries).toHaveLength(2);

      const missing = await app.inject({
        method: "DELETE",
        url: `/api/local/runtime-skills/claude/${encodeURIComponent("user/nope")}`,
        headers: owner,
      });
      expect(missing.statusCode).toBe(404);
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/local/runtime-skills/claude/${encodeURIComponent("user/pdf")}`,
        headers: owner,
      });
      expect(removed.json().backup).toContain(".superhive-skill-backups");

      for (const call of [
        { method: "GET" as const, url: "/api/local/runtime-skills/claude" },
        { method: "GET" as const, url: "/api/local/runtime-overview" },
        {
          method: "POST" as const,
          url: `/api/local/runtime-skills/claude/${encodeURIComponent("user/pdf")}/toggle`,
          payload: { enabled: true },
        },
        {
          method: "POST" as const,
          url: "/api/local/runtime-config/claude/mcp/docs/sync",
          payload: { targets: ["codex"] },
        },
      ]) {
        const agent = await app.inject({
          ...call,
          headers: { authorization: "Bearer join-token" },
        });
        expect(agent.statusCode).toBe(401);
        const other = await app.inject({ ...call, remoteAddress: "10.0.0.20" });
        expect(other.statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }
  });
});
