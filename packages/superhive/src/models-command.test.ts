import { describe, expect, it, vi } from "vitest";
import { claudeConfiguredModel, listModels } from "./models-command.js";

describe("listModels", () => {
  it("reads Codex models from app-server model/list, skipping hidden ones", async () => {
    const listCodex = vi.fn(async () => ({
      data: [
        {
          id: "gpt-a",
          model: "gpt-a",
          displayName: "GPT A",
          isDefault: true,
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "xhigh", description: "Deep" },
          ],
          defaultReasoningEffort: "xhigh",
        },
        { id: "gpt-b", model: "gpt-b", displayName: "gpt-b", hidden: false },
        { id: "gpt-secret", model: "gpt-secret", hidden: true },
      ],
    }));
    const codexConfig = () => ({ providerId: "openai", codexHome: "/nonexistent" });
    await expect(listModels({ provider: "codex", listCodex, codexConfig })).resolves.toEqual({
      provider: "codex",
      source: "runtime",
      models: [
        {
          id: "gpt-a",
          label: "GPT A",
          isDefault: true,
          efforts: ["low", "xhigh"],
          defaultEffort: "xhigh",
        },
        { id: "gpt-b" },
      ],
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(listCodex).toHaveBeenCalledWith("codex");
  });

  it("parses opencode, omp and openclaw output", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "models" && args.length === 1)
        return "opencode/big-pickle\nzhipu-coding/glm-5.3\nsome log line\n";
      if (args.join(" ") === "models --json")
        return JSON.stringify({
          models: [
            {
              kind: "chat",
              selector: "zhipu/glm-5",
              name: "GLM-5",
              reasoning: true,
              thinking: ["low", "high", "max"],
            },
            { kind: "chat", selector: "zhipu/flat", reasoning: false, thinking: [] },
            { kind: "embedding", selector: "zhipu/embed", name: "Embed" },
          ],
        });
      return `🦞 banner\n${JSON.stringify({
        models: [
          { key: "codex/gpt-5.5", name: "gpt-5.5", available: true, tags: ["default"] },
          { key: "x/gone", name: "gone", available: false, tags: [] },
        ],
      })}`;
    });
    expect(
      (await listModels({ provider: "opencode", run, configuredDefault: () => undefined })).models,
    ).toEqual([{ id: "opencode/big-pickle" }, { id: "zhipu-coding/glm-5.3" }]);
    expect(
      (await listModels({ provider: "omp", run, configuredDefault: () => undefined })).models,
    ).toEqual([
      { id: "zhipu/glm-5", label: "GLM-5", efforts: ["off", "low", "high", "max", "auto"] },
      { id: "zhipu/flat" },
    ]);
    expect(
      (await listModels({ provider: "opencode", run, configuredDefault: () => undefined })).efforts,
    ).toEqual([]);
    expect((await listModels({ provider: "openclaw", run })).models).toEqual([
      { id: "codex/gpt-5.5", label: "gpt-5.5", isDefault: true },
    ]);
    // 列表里没标默认的：按运行时自己的配置文件标上
    expect(
      (
        await listModels({
          provider: "opencode",
          run,
          configuredDefault: () => "zhipu-coding/glm-5.3",
        })
      ).models,
    ).toEqual([{ id: "opencode/big-pickle" }, { id: "zhipu-coding/glm-5.3", isDefault: true }]);
  });

  it("reads gemini and agy models from an ACP session", async () => {
    const listAcp = vi.fn(async (provider: "gemini" | "agy") =>
      provider === "gemini"
        ? {
            sessionId: "s",
            models: {
              currentModelId: "gemini-2.5-pro",
              availableModels: [
                { modelId: "auto", name: "Auto" },
                { modelId: "gemini-2.5-pro", name: "gemini-2.5-pro" },
              ],
            },
          }
        : {
            sessionId: "s",
            configOptions: [
              {
                id: "model",
                currentValue: "gemini-3.1-pro",
                options: [
                  { value: "gemini-4-neon", name: "Gemini 4 Neon" },
                  { value: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
                ],
              },
            ],
            models: { availableModels: [{ modelId: "ignored-when-config-options-exist" }] },
          },
    );
    await expect(listModels({ provider: "gemini", listAcp })).resolves.toEqual({
      provider: "gemini",
      source: "runtime",
      models: [
        { id: "auto", label: "Auto" },
        { id: "gemini-2.5-pro", isDefault: true },
      ],
      efforts: [],
    });
    expect((await listModels({ provider: "agy", listAcp, command: "/bin/agy" })).models).toEqual([
      { id: "gemini-4-neon", label: "Gemini 4 Neon" },
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", isDefault: true },
    ]);
    expect(listAcp).toHaveBeenLastCalledWith("agy", "/bin/agy");

    const failed = await listModels({
      provider: "agy",
      listAcp: async () => {
        throw new Error("Authentication required");
      },
    });
    expect(failed).toMatchObject({
      source: "preset",
      models: [],
      error: "Authentication required",
    });
  });

  it("gives common options for runtimes without a model list command", async () => {
    const run = vi.fn();
    const claude = await listModels({
      provider: "claude",
      run,
      configuredDefault: () => undefined,
      claudeApi: async () => ({ kind: "oauth" }),
    });
    expect(claude.source).toBe("preset");
    expect(claude.presetReason).toBe("oauth");
    expect(claude.error).toBeUndefined();
    expect(claude.models.map((model) => model.id)).toEqual(["opus", "sonnet", "haiku", "opusplan"]);
    expect(claude.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const copilot = await listModels({ provider: "copilot", run });
    expect(copilot.models[0]!.id).toBe("auto");
    expect(copilot.efforts).toContain("none");
    expect(run).not.toHaveBeenCalled();
  });

  it("marks the model Claude Code is configured to use as the runtime default", async () => {
    const claudeApi = async () => ({ kind: "oauth" as const });
    const listed = await listModels({
      provider: "claude",
      configuredDefault: () => "claude-opus-5-5[1M]",
      claudeApi,
    });
    expect(listed.models[0]).toEqual({ id: "claude-opus-5-5[1M]", isDefault: true });
    const alias = await listModels({
      provider: "claude",
      configuredDefault: () => "sonnet",
      claudeApi,
    });
    expect(alias.models.find((model) => model.isDefault)?.id).toBe("sonnet");
    expect(claudeConfiguredModel({ ANTHROPIC_MODEL: " haiku " })).toBe("haiku");
    expect(claudeConfiguredModel({ CLAUDE_CONFIG_DIR: "/nonexistent-claude-dir" })).toBeUndefined();
  });

  it("reports why the list could not be fetched instead of failing", async () => {
    const result = await listModels({
      provider: "opencode",
      run: async () => {
        throw new Error("spawn opencode ENOENT");
      },
    });
    expect(result).toEqual({
      provider: "opencode",
      source: "preset",
      models: [],
      efforts: [],
      error: "spawn opencode ENOENT",
    });
  });
});

describe("runtime default model from config files", () => {
  it("reads OpenCode's top-level model and omp's default role", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { ompConfiguredModel, opencodeConfiguredModel } = await import("./models-command.js");
    const root = mkdtempSync(path.join(tmpdir(), "models-default-"));
    mkdirSync(path.join(root, "opencode"));
    writeFileSync(
      path.join(root, "opencode", "opencode.jsonc"),
      '{\n  // 注释\n  "agent": { "x": {\n      "model": "nested/one" } },\n  "model": "zhipu-coding/glm-5.3"\n}\n',
    );
    expect(opencodeConfiguredModel({ XDG_CONFIG_HOME: root })).toBe("zhipu-coding/glm-5.3");
    expect(opencodeConfiguredModel({ XDG_CONFIG_HOME: path.join(root, "none") })).toBeUndefined();
    mkdirSync(path.join(root, ".omp", "agent"), { recursive: true });
    writeFileSync(
      path.join(root, ".omp", "agent", "config.yml"),
      "modelRoles:\n  default: zhipu-coding-plan/glm-5.3:max\n  smol: other/x\ntheme:\n  dark: t\n",
    );
    expect(ompConfiguredModel(root)).toBe("zhipu-coding-plan/glm-5.3");
    expect(ompConfiguredModel(path.join(root, "none"))).toBeUndefined();
  });
});
