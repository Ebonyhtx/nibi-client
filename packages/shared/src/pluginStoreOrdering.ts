import { NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "./plugin-marketplaces.js";
import type { PluginStoreModeOrder } from "./pluginStoreOrder.js";

export const FALLBACK_PLUGIN_STORE_CATEGORY = "other";
export const PLUGIN_STORE_CATEGORY_ORDER: readonly string[] = [
  "productivity",
  "developer-tools",
  "utilities",
  "finance",
  "legal",
  "template",
];

// 完整 ID 避免个人市场的同名插件被误置顶；所有展示入口复用同一默认顺序。
const DOCUMENT_PLUGIN_RANKS = new Map(
  ["pdf", "presentations", "spreadsheets", "documents"].map((name, index) => [
    `${name}@${NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID}`,
    index,
  ]),
);

export function compareDocumentPluginPriority(leftId: string, rightId: string): number {
  return compareRanks(DOCUMENT_PLUGIN_RANKS, leftId, rightId);
}

/** 分类归并只影响展示，市场与引用 Picker 必须使用同一个排序键。 */
export function resolvePluginStoreCategory(category: string | undefined): string | undefined {
  const normalized = category?.trim();
  return normalized === "guides" ? "utilities" : normalized || undefined;
}

interface PluginStoreSortEntry {
  id: string;
  category?: string;
  displayName: string;
  /**
   * 安装态只影响类内先后，不参与分类排序。
   * 可选：Picker/市场预览不传该字段时全部视为未安装，排序行为保持不变。
   */
  installed?: boolean;
  /** 已安装条目内已启用的排在前；undefined（运行时信息缺失）与停用同档。 */
  enabled?: boolean;
}

/**
 * 纯展示排序：分类按配置/产品默认顺序，类内已安装优先（其中已启用优先），
 * 再按配置插件顺序、文档插件优先级和本地化名称稳定兜底。
 *
 * 已安装优先放在分类键之后：分类分组和组间顺序不能被安装态改写，
 * 否则「只有某分类装了插件」会把该分类整体提到最前。
 * 商店的已安装图标条已下线（见 docs/plugin-marketplace-ui-ux.md），
 * 因此安装态必须原地排序而不能另起一条，避免同一插件渲染两次。
 */
export function sortPluginStoreEntries<T>(
  items: readonly T[],
  project: (item: T) => PluginStoreSortEntry,
  locale: string,
  order?: PluginStoreModeOrder,
): T[] {
  const categoryRanks = ranks(order?.categoryOrder);
  const pluginRanks = new Map(
    Object.entries(order?.pluginOrder ?? {}).map(([category, ids]) => [category, ranks(ids)]),
  );
  return items
    .map((item, index) => {
      const entry = project(item);
      return {
        item,
        index,
        ...entry,
        category: resolvePluginStoreCategory(entry.category) ?? FALLBACK_PLUGIN_STORE_CATEGORY,
      };
    })
    .sort(
      (left, right) =>
        compareRanks(categoryRanks, left.category, right.category) ||
        compareCategories(left.category, right.category) ||
        compareInstalledPriority(left, right) ||
        compareRanks(pluginRanks.get(left.category), left.id, right.id) ||
        compareDocumentPluginPriority(left.id, right.id) ||
        left.displayName.localeCompare(right.displayName, locale) ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

/** 0 = 已安装且已启用，1 = 已安装（停用/启用态未知），2 = 未安装。 */
function installedRank(
  entry: Pick<PluginStoreSortEntry, "installed" | "enabled">,
): number {
  if (entry.installed !== true) return 2;
  return entry.enabled === true ? 0 : 1;
}

function compareInstalledPriority(
  left: Pick<PluginStoreSortEntry, "installed" | "enabled">,
  right: Pick<PluginStoreSortEntry, "installed" | "enabled">,
): number {
  return installedRank(left) - installedRank(right);
}

function ranks(order: readonly string[] = []): Map<string, number> {
  const result = new Map<string, number>();
  for (const key of order) if (!result.has(key)) result.set(key, result.size);
  return result;
}
function compareRanks(order: Map<string, number> | undefined, left: string, right: string): number {
  if (!order) return 0;
  return (order.get(left) ?? order.size) - (order.get(right) ?? order.size);
}
function compareCategories(left: string, right: string): number {
  if (left === right) return 0;
  if (left === FALLBACK_PLUGIN_STORE_CATEGORY) return 1;
  if (right === FALLBACK_PLUGIN_STORE_CATEGORY) return -1;
  const a = PLUGIN_STORE_CATEGORY_ORDER.indexOf(left);
  const b = PLUGIN_STORE_CATEGORY_ORDER.indexOf(right);
  if (a !== -1 && b !== -1) return a - b;
  if (a !== -1) return -1;
  if (b !== -1) return 1;
  return left < right ? -1 : 1;
}
