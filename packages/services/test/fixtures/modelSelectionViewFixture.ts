import type { ModelSelectionView } from "@nibi/provider";

/** 普通 API Key Provider 的选择视图，用于 service 装配测试。 */
export function modelSelectionViewFixture(
  values: readonly string[] = ["disabled", "high", "max"],
): ModelSelectionView {
  return {
    revision: 1,
    providers: (["zai-standard-api", "bigmodel-standard-api"] as const).map((providerId) => ({
      providerId,
      config: { visibility: "visible" },
      models: ["GLM-5.2"].map((modelId) => ({
        modelId,
        config: {
          enabled: true,
          properties: {
            requiresMfjsToolSchema: false,
            contextWindow: 200000,
            inputFormat: {
              supportsText: true,
              supportsImage: false,
              supportsVideo: false,
              supportsAudio: false,
              supportsPdf: false,
            },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsJsonSchemaOutput: false,
            supportsNativeWebSearch: false,
            supportsMidConversationSystem: false,
          },
          optionSpecs: {
            reasoningLevel: { values, map: "{}" },
            maxOutputTokens: { max: 32000, map: "{}" },
          },
        },
      })),
    })),
  };
}
