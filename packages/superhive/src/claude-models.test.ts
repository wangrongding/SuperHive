import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchClaudeModels, resolveClaudeApi, useEnvProxy } from "./claude-models.js";
import { listModels } from "./models-command.js";

const KEY = "sk-ant-secret-0123456789";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function writeJson(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

/** 临时的家目录、工作目录和托管配置位置（托管配置默认不存在） */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "claude-models-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd, managedSettings: path.join(root, "managed-settings.json") };
}

const keyApi = {
  kind: "key" as const,
  baseUrl: "https://gw.example.com",
  headers: { "x-api-key": KEY },
  secret: KEY,
};

describe("resolveClaudeApi", () => {
  it("uses the official address and x-api-key when only ANTHROPIC_API_KEY is in the environment", async () => {
    const { home, managedSettings } = fixture();
    await expect(
      resolveClaudeApi({ env: { ANTHROPIC_API_KEY: KEY }, home, managedSettings }),
    ).resolves.toEqual({
      kind: "key",
      baseUrl: "https://api.anthropic.com",
      headers: { "x-api-key": KEY },
      secret: KEY,
    });
  });

  it("layers env like Claude Code: process < user settings < project < local < managed", async () => {
    const { home, cwd, managedSettings } = fixture();
    const env = { ANTHROPIC_BASE_URL: "https://process.example", ANTHROPIC_API_KEY: "process-key" };
    writeJson(path.join(home, ".claude", "settings.json"), {
      env: { ANTHROPIC_BASE_URL: "https://user.example/", ANTHROPIC_AUTH_TOKEN: "user-token" },
    });
    let api = await resolveClaudeApi({ env, home, managedSettings });
    // settings.json 盖过进程环境；AUTH_TOKEN 先于 API_KEY，走 Bearer；末尾的 / 去掉
    expect(api).toMatchObject({
      kind: "key",
      baseUrl: "https://user.example",
      headers: { authorization: "Bearer user-token" },
    });
    // 不带工作目录时看不到项目配置
    writeJson(path.join(cwd, ".claude", "settings.json"), {
      env: { ANTHROPIC_BASE_URL: "https://project.example" },
    });
    api = await resolveClaudeApi({ env, home, managedSettings, cwd });
    expect(api).toMatchObject({ baseUrl: "https://project.example" });
    writeJson(path.join(cwd, ".claude", "settings.local.json"), {
      env: { ANTHROPIC_BASE_URL: "https://local.example" },
    });
    api = await resolveClaudeApi({ env, home, managedSettings, cwd });
    expect(api).toMatchObject({ baseUrl: "https://local.example" });
    writeJson(managedSettings, { env: { ANTHROPIC_BASE_URL: "https://managed.example" } });
    api = await resolveClaudeApi({ env, home, managedSettings, cwd });
    expect(api).toMatchObject({
      baseUrl: "https://managed.example",
      headers: { authorization: "Bearer user-token" },
    });
  });

  it("reads settings from CLAUDE_CONFIG_DIR when it is set", async () => {
    const { root, home, managedSettings } = fixture();
    const dir = path.join(root, "custom-claude");
    writeJson(path.join(dir, "settings.json"), { env: { ANTHROPIC_API_KEY: "custom-key" } });
    await expect(
      resolveClaudeApi({ env: { CLAUDE_CONFIG_DIR: dir }, home, managedSettings }),
    ).resolves.toMatchObject({ headers: { "x-api-key": "custom-key" } });
  });

  it("runs apiKeyHelper when there is no key and sends its output in both headers", async () => {
    const { home, managedSettings } = fixture();
    writeJson(path.join(home, ".claude", "settings.json"), { apiKeyHelper: "~/bin/get-key" });
    const runHelper = vi.fn(async () => `${KEY}\n`);
    await expect(resolveClaudeApi({ env: {}, home, managedSettings, runHelper })).resolves.toEqual({
      kind: "key",
      baseUrl: "https://api.anthropic.com",
      headers: { "x-api-key": KEY, authorization: `Bearer ${KEY}` },
      secret: KEY,
    });
    expect(runHelper).toHaveBeenCalledWith("~/bin/get-key", expect.any(Object));
    // 环境里已有 key 时不跑 helper（和 Claude Code 的优先级一致）
    runHelper.mockClear();
    await resolveClaudeApi({ env: { ANTHROPIC_API_KEY: "k" }, home, managedSettings, runHelper });
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("falls back to oauth without any key, and to cloud for Bedrock / Vertex", async () => {
    const { home, managedSettings } = fixture();
    await expect(resolveClaudeApi({ env: {}, home, managedSettings })).resolves.toEqual({
      kind: "oauth",
    });
    await expect(
      resolveClaudeApi({
        env: { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: KEY },
        home,
        managedSettings,
      }),
    ).resolves.toEqual({ kind: "cloud" });
    await expect(
      resolveClaudeApi({ env: { CLAUDE_CODE_USE_VERTEX: "0" }, home, managedSettings }),
    ).resolves.toEqual({ kind: "oauth" });
  });
});

describe("fetchClaudeModels", () => {
  it("pages through Anthropic's list with after_id and uses display_name", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (!url.includes("after_id"))
        return json({
          data: [
            { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", type: "model" },
            { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", type: "model" },
          ],
          has_more: true,
          last_id: "claude-sonnet-5-5",
        });
      return json({
        data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }],
        has_more: false,
        last_id: "claude-haiku-5-5",
      });
    });
    await expect(fetchClaudeModels(keyApi, fetchImpl)).resolves.toEqual([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [firstUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstUrl).toBe("https://gw.example.com/v1/models?limit=1000");
    expect(init.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01" });
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      "https://gw.example.com/v1/models?limit=1000&after_id=claude-sonnet-5-5",
    );
  });

  it("accepts the OpenAI-style list some gateways return", async () => {
    const fetchImpl = async () =>
      json({ object: "list", data: [{ id: "glm-5.3", object: "model" }, { id: "kimi-k2.7" }] });
    await expect(fetchClaudeModels(keyApi, fetchImpl)).resolves.toEqual([
      { id: "glm-5.3" },
      { id: "kimi-k2.7" },
    ]);
  });

  it("explains 401 without leaking the key", async () => {
    const fetchImpl = async () =>
      json(
        { type: "error", error: { type: "authentication_error", message: `bad key ${KEY}` } },
        401,
      );
    const error = await fetchClaudeModels(keyApi, fetchImpl).catch((reason: Error) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("gw.example.com 返回 401，密钥无效或已过期");
    expect((error as Error).message).not.toContain(KEY);
  });

  it("explains timeouts and unreachable hosts", async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
      );
    await expect(fetchClaudeModels(keyApi, hang, 20)).rejects.toThrow(
      "请求 gw.example.com 超时（1 秒）",
    );
    const refused = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    await expect(fetchClaudeModels(keyApi, refused)).rejects.toThrow(
      "连不上 gw.example.com（ECONNREFUSED）",
    );
  });
});

describe("listModels for claude", () => {
  it("keeps the aliases first, then the configured default, then the fetched models deduplicated", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        data: [
          { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
          { id: "sonnet" },
          { id: "claude-opus-5-5" },
        ],
      }),
    );
    const claudeApi = vi.fn(async () => keyApi);
    const result = await listModels({
      provider: "claude",
      cwd: "/work",
      claudeApi,
      fetch: fetchImpl,
      configuredDefault: () => "claude-opus-5-5[1M]",
    });
    expect(claudeApi).toHaveBeenCalledWith({ cwd: "/work" });
    expect(result.source).toBe("runtime");
    expect(result.error).toBeUndefined();
    expect(result.models.map((model) => model.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
      "opusplan",
      "claude-opus-5-5[1M]",
      "claude-opus-5-5",
    ]);
    expect(result.models.find((model) => model.isDefault)?.id).toBe("claude-opus-5-5[1M]");
    expect(result.models.at(-1)).toEqual({ id: "claude-opus-5-5", label: "Claude Opus 5.5" });
  });

  it("falls back to the aliases with a readable reason when the request fails, never with the key", async () => {
    const result = await listModels({
      provider: "claude",
      claudeApi: async () => keyApi,
      fetch: async () => json({ error: { message: `invalid ${KEY}` } }, 401),
      configuredDefault: () => undefined,
    });
    expect(result.source).toBe("preset");
    expect(result.models.map((model) => model.id)).toEqual(["opus", "sonnet", "haiku", "opusplan"]);
    expect(result.error).toContain("401");
    expect(JSON.stringify(result)).not.toContain(KEY);

    const helperFailed = await listModels({
      provider: "claude",
      claudeApi: async () => {
        throw new Error("apiKeyHelper 执行失败");
      },
      configuredDefault: () => undefined,
    });
    expect(helperFailed).toMatchObject({ source: "preset", error: "apiKeyHelper 执行失败" });
  });

  it("does not request anything when signed in with an account", async () => {
    const fetchImpl = vi.fn();
    const result = await listModels({
      provider: "claude",
      claudeApi: async () => ({ kind: "oauth" }),
      fetch: fetchImpl,
      configuredDefault: () => undefined,
    });
    expect(result).toMatchObject({ source: "preset", presetReason: "oauth" });
    expect(result.error).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("useEnvProxy", () => {
  it("turns on fetch's proxy support only when a proxy is set", () => {
    const setGlobal = vi.fn();
    useEnvProxy({ PATH: "/bin" }, setGlobal);
    expect(setGlobal).not.toHaveBeenCalled();
    useEnvProxy({ https_proxy: "http://127.0.0.1:7890" }, setGlobal);
    expect(setGlobal).toHaveBeenCalledTimes(1);
    expect(() => useEnvProxy({ HTTPS_PROXY: "http://p" }, undefined)).not.toThrow();
  });
});
