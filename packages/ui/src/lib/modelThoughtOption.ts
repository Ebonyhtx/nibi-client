import type { NibiConfigOption } from "@nibi/shared";
import type { ModelSelectionView } from "@nibi/services";

/** 从 Registry 的 ModelConfig Option Specs 读取思考档位。 */
export function resolveModelThoughtOption(params: {
  modelSelectionView: ModelSelectionView;
  providerId: string;
  modelId: string;
  currentValue?: string;
  /**
   * 设置页需要把“历史存过、但已不在 Option Spec 里”的档位原样展示给用户，
   * 否则控件会显示占位符，用户看不出到底是哪条旧配置挡住了保存。
   * 普通选择器保持“非法值视为未选择”的语义。
   */
  preserveInvalidCurrentValue?: boolean;
  formatLevelName?: (level: string) => string;
}): NibiConfigOption | null {
  const provider = params.modelSelectionView.providers.find(
    (candidate) => candidate.providerId === params.providerId,
  );
  const model = provider?.models.find((candidate) => candidate.modelId === params.modelId);
  const reasoning = model?.config.optionSpecs.reasoningLevel;
  if (!reasoning || reasoning.values.length === 0) return null;

  const explicitCurrentValue = params.currentValue ?? "";
  const currentValueSupported =
    explicitCurrentValue.length > 0 && reasoning.values.includes(explicitCurrentValue);

  return {
    id: "thought_level",
    name: "Thought Level",
    category: "thought_level",
    type: "select",
    // Reasoning 没有默认档位；空字符串表示模型已选但用户尚未选择 reasoning。
    currentValue:
      currentValueSupported || (params.preserveInvalidCurrentValue && explicitCurrentValue)
        ? explicitCurrentValue
        : "",
    options: reasoning.values.map((level) => ({
      value: level,
      name: params.formatLevelName?.(level) ?? level,
    })),
  };
}
