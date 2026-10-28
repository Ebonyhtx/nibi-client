import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

/**
 * 插件操作错误的用户面文案。
 *
 * 服务层（agent）的诊断消息是硬编码中文（zh 优先），英文界面不能直接展示；
 * 渲染层按诊断机器码映射到本地化文案。没有映射的码仍显示原始消息（保持行为不变）。
 */
export function resolvePluginErrorMessage(
  intl: IntlShape,
  error: string | null | undefined,
  errorCode: string | null | undefined,
): string | null {
  if (!error) return null;
  switch (errorCode) {
    case "plugin_membership_required":
      return intl.formatMessage({ id: "settings.plugins.error.membershipRequired" });
    default:
      return error;
  }
}
