import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { copilotConfiguredModel, listModels, parseCopilotSession } from "./models-command.js";

/** Copilot CLI 1.0.114 `copilot --acp` 的 session/new（截取，字段与实测一致） */
const session = {
  sessionId: "f3c0e03e-26c2-4f10-847f-85597ab7d8f3",
  models: {
    currentModelId: "claude-sonnet-5.5",
    availableModels: [
      { modelId: "auto", name: "Auto", description: "Let Copilot pick the best model" },
      {
        modelId: "auto",
        name: "Auto",
        description: "Auto",
        _meta: { copilotUsage: "1x", copilotEnablement: "enabled" },
      },
      {
        modelId: "gpt-6.1-terra",
        name: "GPT-6.1 Terra",
        description: "Versatile · Low cost",
        _meta: { copilotUsage: "1x", copilotEnablement: "enabled" },
      },
      {
        modelId: "claude-sonnet-5.5",
        name: "Claude Sonnet 5.5",
        description: "Versatile · Medium cost",
        _meta: { copilotUsage: "1x", copilotEnablement: "enabled" },
      },
      {
        modelId: "claude-haiku-4.5",
        name: "Claude Haiku 4.5",
        description: "Lightweight · Low cost",
        _meta: { copilotUsage: "0.33x", copilotEnablement: "enabled" },
      },
      {
        modelId: "blocked-model",
        name: "Blocked",
        _meta: { copilotUsage: "1x", copilotEnablement: "disabled" },
      },
    ],
  },
  configOptions: [
    { id: "model", category: "model", currentValue: "claude-sonnet-5.5", options: [] },
  ],
};

const AUTO = { id: "auto", label: "Auto（Copilot 自动选）" };

describe("Copilot models", () => {
  it("reads the ACP session: auto first, the rest sorted, duplicates and disabled ones dropped", async () => {
    const listAcp = vi.fn(async () => session);
    await expect(
      listModels({
        provider: "copilot",
        command: "/bin/copilot",
        listAcp,
        configuredDefault: () => undefined,
      }),
    ).resolves.toEqual({
      provider: "copilot",
      source: "runtime",
      models: [
        AUTO,
        {
          id: "claude-haiku-4.5",
          label: "Claude Haiku 4.5",
          description: "Lightweight · Low cost · 0.33x",
        },
        {
          id: "claude-sonnet-5.5",
          label: "Claude Sonnet 5.5",
          description: "Versatile · Medium cost",
          isDefault: true,
        },
        { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", description: "Versatile · Low cost" },
      ],
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(listAcp).toHaveBeenCalledWith("copilot", "/bin/copilot");
  });

  it("adds the configured default right after auto when Copilot doesn't list it", async () => {
    const listed = await listModels({
      provider: "copilot",
      listAcp: async () => session,
      configuredDefault: () => "my-byok-model",
    });
    expect(listed.models.slice(0, 2)).toEqual([AUTO, { id: "my-byok-model", isDefault: true }]);
    // 列表里有的不重复补
    const present = await listModels({
      provider: "copilot",
      listAcp: async () => session,
      configuredDefault: () => "gpt-6.1-terra",
    });
    expect(present.models.filter((model) => model.id === "gpt-6.1-terra")).toHaveLength(1);
  });

  it("marks auto as the default when Copilot is on auto", () => {
    expect(
      parseCopilotSession({
        models: {
          currentModelId: "auto",
          availableModels: [{ modelId: "auto" }, { modelId: "x" }],
        },
      }),
    ).toEqual([{ ...AUTO, isDefault: true }, { id: "x" }]);
  });

  it("falls back to configOptions when the session has no models field", () => {
    expect(
      parseCopilotSession({
        configOptions: [
          {
            id: "model",
            currentValue: "b",
            options: [
              { value: "auto", name: "Auto" },
              { value: "b", name: "B" },
            ],
          },
        ],
      }).map((model) => model.id),
    ).toEqual(["auto", "b"]);
  });

  it("explains why it only gives auto: not signed in, ACP failures, timeouts", async () => {
    const login = await listModels({
      provider: "copilot",
      configuredDefault: () => undefined,
      listAcp: async () => {
        throw Object.assign(new Error("Authentication required"), { code: -32000 });
      },
    });
    expect(login).toMatchObject({ source: "preset", presetReason: "login", models: [AUTO] });
    expect(login.error).toBeUndefined();

    const missing = await listModels({
      provider: "copilot",
      configuredDefault: () => "gpt-6.1-terra",
      listAcp: async () => {
        throw new Error("spawn copilot ENOENT");
      },
    });
    expect(missing).toMatchObject({
      source: "preset",
      error: "spawn copilot ENOENT",
      models: [AUTO, { id: "gpt-6.1-terra", isDefault: true }],
    });
    expect(missing.presetReason).toBeUndefined();

    const timeout = await listModels({
      provider: "copilot",
      configuredDefault: () => undefined,
      listAcp: async () => {
        throw new Error("copilot 没有在 20 秒内返回模型列表");
      },
    });
    expect(timeout).toMatchObject({ source: "preset", error: expect.stringContaining("20 秒") });

    const empty = await listModels({
      provider: "copilot",
      configuredDefault: () => undefined,
      listAcp: async () => ({ sessionId: "s" }),
    });
    expect(empty).toMatchObject({ source: "preset", models: [AUTO] });
    expect(empty.error).toBeTruthy();
  });

  it("reads the configured model from COPILOT_MODEL, then COPILOT_HOME settings", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "copilot-home-"));
    expect(copilotConfiguredModel({ COPILOT_HOME: home })).toBeUndefined();
    writeFileSync(path.join(home, "config.json"), "");
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ model: " gpt-6.1-terra " }));
    expect(copilotConfiguredModel({ COPILOT_HOME: home })).toBe("gpt-6.1-terra");
    expect(copilotConfiguredModel({ COPILOT_HOME: home, COPILOT_MODEL: "claude-haiku-4.5" })).toBe(
      "claude-haiku-4.5",
    );
  });
});
