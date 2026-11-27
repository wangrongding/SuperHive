import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchCodexModels, resolveCodexApi, resolveCodexConfig } from "./codex-models.js";
import { listModels } from "./models-command.js";

const KEY = "sk-codex-secret-0123456789";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** 临时的家目录、系统配置目录和一个 git 项目 */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "codex-models-"));
  const home = path.join(root, "home");
  const systemDir = path.join(root, "etc");
  const repo = path.join(root, "repo");
  const cwd = path.join(repo, "pkg");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home, systemDir, repo, cwd, env: {} as NodeJS.ProcessEnv };
}

const GATEWAY = `
model = "gpt-6.1-sol"
model_provider = "gw"

[model_providers.gw]
name = "gw"
base_url = "https://gw.example.com/v1/"
wire_api = "responses"
experimental_bearer_token = "${KEY}"
`;

describe("resolveCodexConfig", () => {
  it("reads model and provider from $CODEX_HOME/config.toml", () => {
    const { home, systemDir, env } = fixture();
    write(path.join(home, ".codex", "config.toml"), GATEWAY);
    const config = resolveCodexConfig({ home, systemDir, env });
    expect(config.model).toBe("gpt-6.1-sol");
    expect(config.providerId).toBe("gw");
    expect(config.provider?.base_url).toBe("https://gw.example.com/v1/");
  });

  it("honours CODEX_HOME, profiles and defaults to openai", () => {
    const { root, home, systemDir } = fixture();
    const codexHome = path.join(root, "custom");
    write(
      path.join(codexHome, "config.toml"),
      `model = "a"\nprofile = "work"\n[profiles.work]\nmodel = "b"\n`,
    );
    const config = resolveCodexConfig({ home, systemDir, env: { CODEX_HOME: codexHome } });
    expect(config).toEqual({ model: "b", providerId: "openai", codexHome });
  });

  it("layers trusted project .codex/config.toml from project root to cwd, then managed config", () => {
    const { home, systemDir, repo, cwd, env } = fixture();
    write(
      path.join(home, ".codex", "config.toml"),
      `${GATEWAY}\n[projects."${repo}"]\ntrust_level = "trusted"\n`,
    );
    write(path.join(repo, ".codex", "config.toml"), `model = "root-model"\n`);
    write(path.join(cwd, ".codex", "config.toml"), `model = "cwd-model"\n`);
    expect(resolveCodexConfig({ home, systemDir, env, cwd }).model).toBe("cwd-model");
    write(path.join(systemDir, "managed_config.toml"), `model = "managed"\n`);
    expect(resolveCodexConfig({ home, systemDir, env, cwd }).model).toBe("managed");
  });

  it("ignores project config when the project is not trusted", () => {
    const { home, systemDir, repo, cwd, env } = fixture();
    write(path.join(home, ".codex", "config.toml"), GATEWAY);
    write(path.join(repo, ".codex", "config.toml"), `model = "root-model"\n`);
    expect(resolveCodexConfig({ home, systemDir, env, cwd }).model).toBe("gpt-6.1-sol");
  });

  it("trusts a git worktree through its main repository", () => {
    const { root, home, systemDir, repo, env } = fixture();
    const worktree = path.join(root, "wt");
    write(path.join(worktree, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "wt")}\n`);
    write(
      path.join(home, ".codex", "config.toml"),
      `${GATEWAY}\n[projects."${repo}"]\ntrust_level = "trusted"\n`,
    );
    write(path.join(worktree, ".codex", "config.toml"), `model = "wt-model"\n`);
    expect(resolveCodexConfig({ home, systemDir, env, cwd: worktree }).model).toBe("wt-model");
  });
});

describe("resolveCodexApi", () => {
  const base = { providerId: "gw", codexHome: "/nonexistent" };

  it("uses experimental_bearer_token, http_headers, env_http_headers and query_params", () => {
    const api = resolveCodexApi(
      {
        ...base,
        provider: {
          base_url: "https://gw.example.com/v1/",
          experimental_bearer_token: KEY,
          http_headers: { "x-team": "hive" },
          env_http_headers: { "x-org": "ORG_ID", "x-missing": "NOT_SET" },
          query_params: { "api-version": "2025-01-01" },
        },
      },
      { ORG_ID: "org-1" },
    );
    expect(api).toEqual({
      kind: "gateway",
      providerId: "gw",
      baseUrl: "https://gw.example.com/v1",
      headers: { "x-team": "hive", "x-org": "org-1", authorization: `Bearer ${KEY}` },
      query: { "api-version": "2025-01-01" },
      secrets: [KEY, `Bearer ${KEY}`],
    });
  });

  it("prefers env_key over experimental_bearer_token and fails clearly when it is empty", () => {
    const provider = {
      base_url: "https://gw.example.com/v1",
      env_key: "GW_KEY",
      experimental_bearer_token: "other",
    };
    const api = resolveCodexApi({ ...base, provider }, { GW_KEY: KEY });
    expect(api.kind === "gateway" && api.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(() => resolveCodexApi({ ...base, provider }, {})).toThrow(/GW_KEY/);
  });

  it("uses auth.json's OPENAI_API_KEY for requires_openai_auth, and gives up on ChatGPT login", () => {
    const { root } = fixture();
    const provider = { base_url: "https://gw.example.com/v1", requires_openai_auth: true };
    write(path.join(root, "auth.json"), JSON.stringify({ OPENAI_API_KEY: KEY }));
    const api = resolveCodexApi({ providerId: "gw", codexHome: root, provider }, {});
    expect(api.kind === "gateway" && api.headers.authorization).toBe(`Bearer ${KEY}`);
    write(path.join(root, "auth.json"), JSON.stringify({ tokens: { access_token: "x" } }));
    expect(resolveCodexApi({ providerId: "gw", codexHome: root, provider }, {}).kind).toBe(
      "account",
    );
  });

  it("does not query the official openai provider or command-based auth", () => {
    expect(resolveCodexApi({ providerId: "openai", codexHome: "/x" }, {}).kind).toBe("official");
    expect(
      resolveCodexApi(
        { ...base, provider: { base_url: "https://gw", auth: { command: "get-token" } } },
        {},
      ).kind,
    ).toBe("unsupported");
  });
});

describe("fetchCodexModels", () => {
  const api = {
    kind: "gateway" as const,
    providerId: "gw",
    baseUrl: "https://gw.example.com/v1",
    headers: { authorization: `Bearer ${KEY}` },
    query: { "api-version": "1" },
    secrets: [KEY],
  };

  it("GETs {base_url}/models with the provider's headers and reads data[].id", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ data: [{ id: "gpt-b" }, { id: "gpt-a" }, { id: "gpt-a" }, { object: "x" }] }),
    );
    await expect(fetchCodexModels(api, fetchImpl)).resolves.toEqual(["gpt-b", "gpt-a"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gw.example.com/v1/models?api-version=1",
      expect.objectContaining({
        headers: { authorization: `Bearer ${KEY}`, accept: "application/json" },
      }),
    );
  });

  it("explains failures without leaking the key", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { message: `bad key ${KEY}` } }, 401));
    const error = await fetchCodexModels(api, fetchImpl).catch((e: Error) => e);
    expect(String(error)).toContain("gw.example.com 返回 401");
    expect(String(error)).not.toContain(KEY);
    const missing = vi.fn(async () => json({}, 404));
    await expect(fetchCodexModels(api, missing)).rejects.toThrow("（/models）");
  });
});

describe("listModels codex", () => {
  const catalog = {
    data: [
      {
        model: "gpt-6.1-sol",
        displayName: "GPT 6.1 Sol",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
        defaultReasoningEffort: "high",
      },
      { model: "gpt-catalog-only", isDefault: true },
    ],
  };
  const gatewayConfig = () => ({
    model: "gpt-6.1-sol",
    providerId: "gw",
    codexHome: "/nonexistent",
    provider: { base_url: "https://gw.example.com/v1", experimental_bearer_token: KEY },
  });
  const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

  it("lists the gateway's models sorted, with efforts from model/list and the configured default", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ data: [{ id: "gpt-6.2-sol" }, { id: "gpt-6.1-sol" }, { id: "claude-x" }] }),
    );
    const result = await listModels({
      provider: "codex",
      cwd: "/work",
      codexConfig: gatewayConfig,
      listCodex: async () => catalog,
      fetch: fetchImpl,
    });
    expect(result).toEqual({
      provider: "codex",
      source: "runtime",
      models: [
        { id: "claude-x" },
        {
          id: "gpt-6.1-sol",
          label: "GPT 6.1 Sol",
          isDefault: true,
          efforts: ["low", "high"],
          defaultEffort: "high",
        },
        { id: "gpt-6.2-sol" },
      ],
      efforts,
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("adds the configured model in front when the gateway does not list it", async () => {
    const result = await listModels({
      provider: "codex",
      codexConfig: gatewayConfig,
      listCodex: async () => catalog,
      fetch: async () => json({ data: [{ id: "gpt-a" }] }),
    });
    expect(result.models).toEqual([{ id: "gpt-6.1-sol", isDefault: true }, { id: "gpt-a" }]);
  });

  it("falls back to model/list with the reason when the gateway fails, still showing the configured model", async () => {
    const result = await listModels({
      provider: "codex",
      codexConfig: () => ({ ...gatewayConfig(), model: "gpt-new" }),
      listCodex: async () => catalog,
      fetch: async () => json({ error: "nope" }, 500),
    });
    expect(result.source).toBe("preset");
    expect(result.error).toContain("gw.example.com 返回 500");
    expect(result.models.map((model) => [model.id, model.isDefault ?? false])).toEqual([
      ["gpt-new", true],
      ["gpt-6.1-sol", false],
      ["gpt-catalog-only", false],
    ]);
  });

  it("uses model/list for the official provider, marking the configured model as default", async () => {
    const fetchImpl = vi.fn();
    const result = await listModels({
      provider: "codex",
      codexConfig: () => ({ model: "gpt-6.1-sol", providerId: "openai", codexHome: "/x" }),
      listCodex: async () => catalog,
      fetch: fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.source).toBe("runtime");
    expect(result.error).toBeUndefined();
    expect(result.models.find((model) => model.isDefault)?.id).toBe("gpt-6.1-sol");
  });

  it("still shows the configured model when both sources fail", async () => {
    const result = await listModels({
      provider: "codex",
      codexConfig: () => ({ model: "gpt-x", providerId: "openai", codexHome: "/x" }),
      listCodex: async () => {
        throw new Error("spawn codex ENOENT");
      },
    });
    expect(result).toEqual({
      provider: "codex",
      source: "preset",
      models: [{ id: "gpt-x", isDefault: true }],
      efforts,
      error: "spawn codex ENOENT",
    });
  });
});
