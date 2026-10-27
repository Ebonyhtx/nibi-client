import { describe, expect, it } from "vitest";
import type { ModelSelectionView } from "@nibi/services";
import { buildRegistryModelSelectGroups } from "../src/lib/modelSelectionGroups.js";

describe("model selection groups", () => {
  it("按模型真实能力展示视觉标", () => {
    const view: ModelSelectionView = {
      revision: 1,
      providers: [
        {
          providerId: "fixture",
          config: {
            logo: { type: "builtin", key: "deepseek" },
            access: { type: "api-key", apiKey: "key" },
            api: { type: "anthropic-messages" },
          },
          models: ["GLM-5.3", "GLM-5.3-Flash", "GLM-4.7"].map((modelId) => ({
            modelId,
            config: { properties: { inputFormat: { supportsImage: true } } },
          })),
        },
      ],
    };
    const items = buildRegistryModelSelectGroups("glm", view)[0]!.items;
    expect(buildRegistryModelSelectGroups("glm", view)[0]!.logo).toEqual({
      type: "builtin",
      key: "deepseek",
    });
    expect(items[0]!.supportsVisionInput).toBe(true);
    expect(items[1]!.supportsVisionInput).toBe(true);
    expect(items[2]!.supportsVisionInput).toBe(true);
  });

  it("保留带前缀和多段斜杠的精确模型 ID；不从名称推断视觉能力", () => {
    const modelId = "upstream/family/vision-preview";
    const view: ModelSelectionView = {
      revision: 1,
      providers: [
        {
          providerId: "aggregator",
          config: { api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" } },
          models: [{ modelId, config: { properties: { inputFormat: { supportsImage: true } } } }],
        },
      ],
    };
    expect(buildRegistryModelSelectGroups("glm", view)[0]?.items).toEqual([
      {
        key: `registry-provider:aggregator:${modelId}`,
        value: "custom:aggregator:upstream%2Ffamily%2Fvision-preview",
        name: modelId,
        supportsVisionInput: true,
      },
    ]);
    view.providers[0]!.models[0]!.config = {};
    expect(buildRegistryModelSelectGroups("glm", view)[0]?.items[0]).not.toHaveProperty(
      "supportsVisionInput",
    );
  });

  it("直接把 Registry API Provider 投影为有序模型组", () => {
    const selectionView: ModelSelectionView = {
      revision: 7,
      providers: [
        {
          providerId: "anthropic-api",
          providerName: "Anthropic API",
          config: {
            access: { type: "api-key", apiKey: "secret" },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://example.com/anthropic",
            },
            models: ["claude-a", "claude-b"],
          },
          models: [
            {
              modelId: "claude-a",
              config: { properties: { inputFormat: { supportsImage: true } } },
            },
            { modelId: "claude-b", config: {} },
          ],
        },
        {
          providerId: "openai-api",
          providerName: "OpenAI API",
          config: {
            access: { type: "api-key", apiKey: "secret" },
            api: {
              type: "openai-responses",
              baseUrl: "https://example.com/openai",
            },
            models: ["model-a"],
          },
          models: [{ modelId: "model-a", config: {} }],
        },
      ],
    };

    expect(buildRegistryModelSelectGroups("glm", selectionView)).toEqual([
      {
        key: "registry-provider:anthropic-api",
        label: "Anthropic API",
        labelBadge: "API",
        items: [
          {
            key: "registry-provider:anthropic-api:claude-a",
            value: "custom:anthropic-api:claude-a",
            name: "claude-a",
            supportsVisionInput: true,
          },
          {
            key: "registry-provider:anthropic-api:claude-b",
            value: "custom:anthropic-api:claude-b",
            name: "claude-b",
          },
        ],
      },
      {
        key: "registry-provider:openai-api",
        label: "OpenAI API",
        labelBadge: "API",
        items: [
          {
            key: "registry-provider:openai-api:model-a",
            value: "custom:openai-api:model-a",
            name: "model-a",
          },
        ],
      },
    ]);
  });
});
