import type { DataSyncCategoryId } from "@/data-sync/contract.js";
import type { DataSyncIntl } from "@/data-sync/ui/DataSyncRowItem.js";

const CATEGORY_LABEL_IDS: Record<DataSyncCategoryId, string> = {
  skills: "settings.dataSync.category.skills",
  mcp: "settings.dataSync.category.mcp",
  commands: "settings.dataSync.category.commands",
  hooks: "settings.dataSync.category.hooks",
  subagents: "settings.dataSync.category.subagents",
  plugins: "settings.dataSync.category.plugins",
};

/** 分类名在所有数据同步子视图里都经同一映射，避免概览与分类页文案漂移。 */
export function categoryLabel(intl: DataSyncIntl, category: DataSyncCategoryId): string {
  return intl.formatMessage({ id: CATEGORY_LABEL_IDS[category] });
}
