// 会话派生（stable fork / 编辑前分叉 / 辅助对话）的常驻 Selection 推导。
// 从 v4-bridge 抽出：这些函数是纯选型推导，与网关接线无关，需要独立回归测试。
import type { ModelSelection } from "@nibi/contracts";

export function cloneModelSelection(
  selection: ModelSelection | undefined,
): ModelSelection | undefined {
  if (!selection) return undefined;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

export function modelSelectionWithOptionFallback(
  selection: ModelSelection | undefined,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  if (!selection) return fallback && cloneModelSelection(fallback);
  // 兼容旧 fork 消息可能缺少 reasoning；输出预算属于单次请求，不属于 Selection。
  const reasoningLevel = selection.options?.reasoningLevel ?? fallback?.options?.reasoningLevel;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(reasoningLevel !== undefined ? { options: { reasoningLevel } } : {}),
  };
}

export function derivedSessionModelSelection(
  messageSelection: ModelSelection | undefined,
  sessionSelection: ModelSelection | undefined,
): ModelSelection | undefined {
  return modelSelectionWithOptionFallback(messageSelection, sessionSelection);
}
