import type { useNibiIntl } from "@/i18n/IntlProvider.js";

type IntlShape = ReturnType<typeof useNibiIntl>["intl"];

/**
 * 服务层（agent）的市场来源诊断是英文原文（`marketplace.ts`），中文界面不能直接展示。
 * 新错误应带 `diagnosticCode`；这里先为已上屏的几条做消息级映射，其余原文回退。
 * `detail` 保留原始路径/来源，不做翻译。
 */
const MARKETPLACE_SOURCE_DIAGNOSTICS: readonly {
  pattern: RegExp;
  id: string;
}[] = [
  {
    pattern: /^Marketplace source path does not exist: (.+)$/u,
    id: "settings.plugins.error.sourcePathMissing",
  },
  {
    pattern: /^Unsupported (?:marketplace|(?:or missing )?plugin) source: (.+)$/u,
    id: "settings.plugins.error.sourceUnsupported",
  },
  {
    pattern: /^Marketplace file must be a \.json file: (.+)$/u,
    id: "settings.plugins.error.sourceNotJson",
  },
  {
    pattern: /^Marketplace source path is not a file or directory: (.+)$/u,
    id: "settings.plugins.error.sourceNotFileOrDir",
  },
];

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
      break;
  }
  const message = error.trim();
  for (const diagnostic of MARKETPLACE_SOURCE_DIAGNOSTICS) {
    const match = diagnostic.pattern.exec(message);
    if (!match) continue;
    return intl.formatMessage({ id: diagnostic.id }, { detail: match[1] ?? "" });
  }
  return error;
}
