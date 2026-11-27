import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { SecretBox } from "./im/secret-box.js";
import type { SpawnAgent } from "./local-agents.js";
import { RuntimeCredentialStore } from "./runtime-credentials.js";
import { RuntimeProfileStore, type RuntimeProfileStoreOptions } from "./runtime-profiles.js";

const GW_KEY = "sk-gateway-secret-0123456789";
const KIMI_KEY = "sk-kimi-secret-abcdefghijkl";
const CC_KEY = "sk-ccswitch-secret-zyxwvutsrq";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fixture(options: Partial<RuntimeProfileStoreOptions> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "hive-profiles-"));
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
    claudeManagedSettings: path.join(home, "managed-settings.json"),
  });
  const db = new Database(":memory:");
  const store = new RuntimeProfileStore({
    db,
    box: new SecretBox(Buffer.alloc(32, 7)),
    credentials,
    keychainHas: async () => false,
    platform: "linux",
    ...options,
  });
  const settings = path.join(claudeDir, "settings.json");
  const config = path.join(codexHome, "config.toml");
  const readJson = () => JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
  return { home, claudeDir, codexHome, db, store, settings, config, readJson };
}

const CLAUDE_SETTINGS = {
  env: {
    ANTHROPIC_BASE_URL: "https://gw.example.com",
    ANTHROPIC_AUTH_TOKEN: GW_KEY,
    ANTHROPIC_MODEL: "glm-5",
  },
  permissions: { defaultMode: "acceptEdits" },
  enabledPlugins: { "figma@claude-plugins-official": true },
};

describe("RuntimeProfileStore: Claude Code", () => {
  it("keeps the current config, switches to a saved one and to the official subscription", async () => {
    const { store, settings, readJson, claudeDir, db } = fixture();
    writeFileSync(settings, JSON.stringify(CLAUDE_SETTINGS, null, 2));

    let list = await store.list("claude");
    // 现在的配置还没存成一套
    expect(list.unsaved).toBe(true);
    expect(list.official).toMatchObject({
      active: false,
      login: "no",
      loginCommand: "claude auth login",
    });
    expect(list.official?.leftover).toEqual(["env.ANTHROPIC_MODEL = glm-5"]);

    const kimi = store.create("claude", {
      name: "Kimi",
      baseUrl: "https://api.kimi.example.com/anthropic",
      apiKey: KIMI_KEY,
    });
    // key 在数据库里是密文
    const raw = JSON.stringify(db.prepare("SELECT * FROM runtime_profiles").all());
    expect(raw).not.toContain(KIMI_KEY);

    // 切过去：原配置先自动存成一套（按主机名起名），只改地址和 key，其余设置原样保留
    expect(store.switchTo("claude", { profileId: kimi })).toEqual({ saved: "gw.example.com" });
    expect(readJson()).toEqual({
      ...CLAUDE_SETTINGS,
      env: {
        ...CLAUDE_SETTINGS.env,
        ANTHROPIC_BASE_URL: "https://api.kimi.example.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: KIMI_KEY,
      },
    });
    // 写之前备份了原文件
    expect(
      readdirSync(claudeDir).some((name) => name.startsWith("settings.json.superhive-bak-")),
    ).toBe(true);
    list = await store.list("claude");
    expect(list.unsaved).toBe(false);
    expect(list.profiles.map((profile) => [profile.name, profile.source, profile.active])).toEqual([
      ["Kimi", "hive", true],
      ["gw.example.com", "current", false],
    ]);
    expect(JSON.stringify(list)).not.toContain(KIMI_KEY);
    expect(JSON.stringify(list)).not.toContain(GW_KEY);

    // 切到官方：只删地址和 key 三项，模型等其它设置不动
    expect(store.switchTo("claude", { official: true })).toEqual({});
    expect(readJson()).toEqual({ ...CLAUDE_SETTINGS, env: { ANTHROPIC_MODEL: "glm-5" } });
    list = await store.list("claude");
    expect(list.official?.active).toBe(true);
    expect(list.profiles.every((profile) => !profile.active)).toBe(true);
    expect(list.unsaved).toBe(false);

    // 再切回原来那套
    const original = list.profiles.find((profile) => profile.source === "current")!;
    store.switchTo("claude", { profileId: original.id });
    expect(readJson()).toEqual(CLAUDE_SETTINGS);
    expect((await store.list("claude")).profiles.find((p) => p.id === original.id)?.active).toBe(
      true,
    );
  });

  it("tells whether the account is signed in without reading the credentials", async () => {
    const { store } = fixture({
      platform: "darwin",
      keychainHas: async (service) => service === "Claude Code-credentials",
    });
    expect((await store.list("claude")).official?.login).toBe("yes");

    const linux = fixture();
    expect((await linux.store.list("claude")).official?.login).toBe("no");
    writeFileSync(
      path.join(linux.home, ".claude.json"),
      JSON.stringify({ oauthAccount: { a: 1 } }),
    );
    expect((await linux.store.list("claude")).official?.login).toBe("yes");
  });

  it("refuses to switch while cc-switch's proxy takeover owns the config", async () => {
    const { store, settings } = fixture();
    writeFileSync(
      settings,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
          ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
        },
      }),
    );
    const list = await store.list("claude");
    expect(list.note).toContain("代理接管");
    expect(() => store.switchTo("claude", { official: true })).toThrow(/代理接管/);
  });
});

const CODEX_CONFIG = `model = "gpt-6.1-sol"
model_provider = "test-gateway" # 网关

[model_providers.test-gateway]
name = "test-gateway"
base_url = "https://gw.example.com/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "${GW_KEY}"

[projects."/Users/me/code"]
trust_level = "trusted"
`;

describe("RuntimeProfileStore: Codex", () => {
  it("drops model_provider for the official login and points it back for a saved one", async () => {
    const { store, config, codexHome } = fixture();
    writeFileSync(config, CODEX_CONFIG);
    writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "x" } }),
    );
    let list = await store.list("codex");
    expect(list.official).toMatchObject({
      active: false,
      login: "yes",
      loginCommand: "codex login",
    });
    expect(list.unsaved).toBe(true);

    expect(store.switchTo("codex", { official: true })).toEqual({ saved: "gw.example.com" });
    const official = readFileSync(config, "utf8");
    expect(official).not.toContain("model_provider =");
    // provider 小节留着，切回来不用重建；auth.json 不碰
    expect(official).toContain("[model_providers.test-gateway]");
    expect(official).toContain(`trust_level = "trusted"`);
    list = await store.list("codex");
    expect(list.official?.active).toBe(true);
    expect(list.official?.leftover).toEqual(["model = gpt-6.1-sol"]);
    const saved = list.profiles[0]!;
    expect(saved.providerId).toBe("test-gateway");

    // 新加一套：没有对应小节就新建一节，再把 model_provider 指过去
    const other = store.create("codex", {
      name: "Other",
      baseUrl: "https://other.example.com/v1",
      apiKey: KIMI_KEY,
    });
    store.switchTo("codex", { profileId: saved.id });
    expect(readFileSync(config, "utf8")).toContain(`model_provider = "test-gateway"`);
    store.switchTo("codex", { profileId: other });
    const next = readFileSync(config, "utf8");
    expect(next).toContain(`model_provider = "test-gateway"`);
    expect(next).toContain(`base_url = "https://other.example.com/v1"`);
    expect(next).toContain(`experimental_bearer_token = "${KIMI_KEY}"`);
    expect((await store.list("codex")).profiles.map((p) => p.active)).toEqual([false, true]);

    // 从官方切到一套、而 config.toml 里没有任何自定义 provider：新建 [model_providers.superhive]
    const bare = fixture();
    writeFileSync(bare.config, `model = "gpt-5"\n`);
    const id = bare.store.create("codex", {
      name: "GW",
      baseUrl: "https://gw.example.com/v1",
      apiKey: GW_KEY,
    });
    bare.store.switchTo("codex", { profileId: id });
    expect(readFileSync(bare.config, "utf8")).toBe(
      `model = "gpt-5"\nmodel_provider = "superhive"\n\n[model_providers.superhive]\nname = "superhive"\nbase_url = "https://gw.example.com/v1"\nwire_api = "responses"\nexperimental_bearer_token = "${GW_KEY}"\n`,
    );
    expect((await bare.store.list("codex")).official?.login).toBe("no");
  });

  it("leaves a provider whose key comes from an env var alone", async () => {
    const { store, config } = fixture();
    writeFileSync(
      config,
      `model_provider = "gw"\n\n[model_providers.gw]\nbase_url = "https://gw.example.com/v1"\nenv_key = "GW_KEY"\n`,
    );
    const id = store.create("codex", {
      name: "x",
      baseUrl: "https://x.example.com",
      apiKey: KIMI_KEY,
    });
    expect(() => store.switchTo("codex", { profileId: id })).toThrow(/GW_KEY/);
    expect(readFileSync(config, "utf8")).toContain("https://gw.example.com/v1");
  });
});

/** 按 cc-switch 的表结构建一个假的数据库（只建用到的列） */
function ccSwitch(home: string) {
  const dir = path.join(home, ".cc-switch");
  mkdirSync(dir);
  const file = path.join(dir, "cc-switch.db");
  const db = new Database(file);
  db.exec(`CREATE TABLE providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL,
    category TEXT, created_at INTEGER, sort_index INTEGER, is_current BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY (id, app_type))`);
  const insert = db.prepare(
    "INSERT INTO providers (id, app_type, name, settings_config, category, created_at, is_current) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("claude-official", "claude", "Claude Official", '{"env":{}}', "official", 1, 0);
  insert.run(
    "p1",
    "claude",
    "opus-gw",
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://gw.example.com", ANTHROPIC_AUTH_TOKEN: GW_KEY },
    }),
    "custom",
    2,
    1,
  );
  insert.run(
    "p2",
    "claude",
    "cc-only",
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://cc.example.com", ANTHROPIC_API_KEY: CC_KEY },
    }),
    null,
    3,
    0,
  );
  insert.run(
    "c1",
    "codex",
    "gpt",
    JSON.stringify({
      auth: { OPENAI_API_KEY: CC_KEY },
      config: `model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://cx.example.com/v1"\n`,
    }),
    null,
    1,
    1,
  );
  db.close();
  // 设备级的当前供应商优先于数据库的 is_current
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ currentProviderClaude: "p2" }));
  const hash = () =>
    readdirSync(dir)
      .sort()
      .map(
        (name) =>
          `${name}:${createHash("sha256")
            .update(readFileSync(path.join(dir, name)))
            .digest("hex")}`,
      )
      .join("\n");
  return { dir, hash };
}

describe("RuntimeProfileStore: cc-switch", () => {
  it("lists cc-switch's providers read-only and imports the chosen ones", async () => {
    const { store, home, settings } = fixture();
    writeFileSync(settings, JSON.stringify(CLAUDE_SETTINGS));
    const cc = ccSwitch(home);
    const before = cc.hash();

    let list = await store.list("claude");
    expect(list.ccSwitch?.current).toBe("cc-only");
    expect(
      list.ccSwitch?.providers.map((item) => [item.id, item.name, item.current, item.apiKey]),
    ).toEqual([
      ["p1", "opus-gw", false, "sk-g••••6789"],
      ["p2", "cc-only", true, "sk-c••••tsrq"],
    ]);
    expect(JSON.stringify(list)).not.toContain(CC_KEY);

    expect(store.importCcSwitch("claude", ["p1", "p2"])).toBe(2);
    // 再导一次不重复
    expect(store.importCcSwitch("claude", ["p1", "p2"])).toBe(0);
    list = await store.list("claude");
    expect(list.profiles.map((item) => [item.name, item.source, item.active])).toEqual([
      ["opus-gw", "cc-switch", true],
      ["cc-only", "cc-switch", false],
    ]);
    expect(list.ccSwitch?.providers.every((item) => item.imported)).toBe(true);
    expect(list.ccSwitch?.currentProfile).toBe("cc-only");
    expect(list.unsaved).toBe(false);

    // Codex 的供应商：config.toml 原文里的 provider 小节，key 在 auth.json
    const codex = await store.list("codex");
    expect(codex.ccSwitch?.providers.map((item) => item.baseUrl)).toEqual([
      "https://cx.e••••.com/…",
    ]);
    store.importCcSwitch("codex", ["c1"]);
    expect((await store.list("codex")).profiles[0]).toMatchObject({
      name: "gpt",
      providerId: "gw",
    });

    // 只读：cc-switch 目录下的文件一个字节都没变
    expect(cc.hash()).toBe(before);
  });

  it("has nothing to show when cc-switch isn't installed", async () => {
    const { store } = fixture();
    expect((await store.list("claude")).ccSwitch).toBeNull();
    expect((await store.list("opencode")).official).toBeNull();
  });
});

describe("runtime profile routes", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function setup() {
    const { home, claudeDir, codexHome, settings, readJson } = fixture();
    writeFileSync(settings, JSON.stringify(CLAUDE_SETTINGS));
    const logs: string[] = [];
    const openTerminal = vi.fn<(command: string) => Promise<void>>(async () => undefined);
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      logger: { level: "info", stream: { write: (line: string) => void logs.push(line) } },
      runtimeCredentials: new RuntimeCredentialStore({
        home,
        env: {},
        claudeDir,
        codexHome,
        claudeManagedSettings: path.join(home, "managed-settings.json"),
      }),
      runtimeProfileOptions: { keychainHas: async () => false, platform: "linux" },
      openTerminal,
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        spawn: vi.fn<SpawnAgent>(),
        probe: async () => ({ installed: true, version: "1.0.0" }),
      },
    });
    close = () => app.close();
    const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
      ownerToken: string;
    };
    return { app, owner: { "x-hive-owner": session.ownerToken }, logs, openTerminal, readJson };
  }

  it("adds, switches and opens the login terminal for the local owner, without logging keys", async () => {
    const { app, owner, logs, openTerminal, readJson } = await setup();
    const base = "/api/local/runtime-config/claude";
    const created = await app.inject({
      method: "POST",
      url: `${base}/profiles`,
      headers: owner,
      payload: { name: "Kimi", baseUrl: "https://kimi.example.com", apiKey: KIMI_KEY },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain(KIMI_KEY);
    const id = (created.json().profiles.profiles as Array<{ id: string }>)[0]!.id;

    const switched = await app.inject({
      method: "POST",
      url: `${base}/profiles/switch`,
      headers: owner,
      payload: { profileId: id },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().saved).toBe("gw.example.com");
    // 一起返回最新的配置（接入那一栏的地址和 key 跟着变）
    expect(switched.json().config.credentials.apiKey.masked).toBe("sk-k••••ijkl");
    expect((readJson().env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe(KIMI_KEY);

    const official = await app.inject({
      method: "POST",
      url: `${base}/profiles/switch`,
      headers: owner,
      payload: { official: true },
    });
    expect(official.json().profiles.official.active).toBe(true);

    const login = await app.inject({ method: "POST", url: `${base}/login`, headers: owner });
    expect(login.statusCode).toBe(200);
    expect(openTerminal).toHaveBeenCalledWith("claude auth login");
    // opencode 没有官方这一档
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/local/runtime-config/opencode/login",
          headers: owner,
        })
      ).statusCode,
    ).toBe(400);

    const all = logs.join("\n");
    expect(all).not.toContain(KIMI_KEY);
    expect(all).not.toContain(GW_KEY);
    expect(all).toContain('"action":"switch"');
    expect(all).toContain('"target":["official"]');

    // 只给本机房主
    const agent = await app.inject({
      method: "GET",
      url: `${base}/profiles`,
      headers: { authorization: "Bearer join-token" },
    });
    expect(agent.statusCode).toBe(401);
    const other = await app.inject({
      method: "POST",
      url: `${base}/profiles/switch`,
      payload: { official: true },
      remoteAddress: "10.0.0.20",
    });
    expect(other.statusCode).toBe(403);

    const bad = await app.inject({
      method: "POST",
      url: `${base}/profiles`,
      headers: owner,
      payload: { name: "x", baseUrl: "ftp://x", apiKey: "k" },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: `${base}/profiles/switch`,
      headers: owner,
      payload: { profileId: "nope" },
    });
    expect(missing.statusCode).toBe(404);
  });
});
