import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseModelConfig, parseZCodeBuiltinModelConfigRules } from "@nibi/provider";

describe("MCS published capability boundaries", () => {
  it("supports known Claude models across sites, without granting Sonnet or a different API", async () => {
    const release = JSON.parse(
      await readFile(
        new URL("../../../config/provider/nibi-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
    for (const baseUrl of ["https://api.anthropic.com/v1", "https://proxy.example/v1"]) {
      for (const modelId of [
        "claude-opus-4-8",
        "anthropic/claude-opus-4.8",
        "gateway/claude-opus-4-8:free",
        "claude-opus-5",
        "claude-fable-5",
        "claude-fable-5-1",
        "claude-mythos-5-1",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
        "claude-unknown",
      ]) {
        const config = rules.resolve({
          providerId: "fixture",
          modelId,
          baseUrl,
          apiType: "anthropic-messages",
        });
        const expected = !modelId.includes("sonnet") && !modelId.includes("unknown");
        expect(config.properties?.supportsMidConversationSystem, `${baseUrl}/${modelId}`).toBe(
          expected,
        );
        expect(
          config.overlay(parseModelConfig({ properties: { supportsMidConversationSystem: false } }))
            .properties?.supportsMidConversationSystem,
        ).toBe(false);
        expect(
          rules.resolve({
            providerId: "fixture",
            modelId,
            baseUrl,
            apiType: "openai-chat-completions",
          }).properties?.supportsMidConversationSystem,
        ).toBe(false);
      }
    }
    for (const provider of release.config.providerConfigRules.providerRules) {
      const { api } = provider.config;
      const config = rules.resolve({
        providerId: provider.providerId,
        modelId: "GLM-5.3-Flash",
        apiType: api.type,
        baseUrl: api.baseUrl,
      });
      expect(config.properties?.supportsMidConversationSystem, provider.providerId).toBe(true);
      expect(config.properties?.supportsNativeWebSearch, provider.providerId).toBe(true);
    }
    // 上游 Coding Plan 网关（zcode.z.ai/.../zcode-plan）已随套餐业务移除，
    // 对应的能力规则不再存在；这里只保留按模型/站点判定的边界。
  });
});
