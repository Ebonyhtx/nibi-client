/**
 * 设置搜索索引。
 *
 * 索引只从 `settingsPageConfig` 读取：分区标题、分区关键词、分区内深链项
 * 都是配置的一部分，搜索组件不再另维护一份设置清单。
 *
 * 匹配是纯函数，方便单测覆盖；UI 只负责输入、键盘选择和跳转。
 */
import {
  isSettingsSectionAvailable,
  type SettingsSectionDefinition,
  type SettingsSectionId,
} from "@/settings/settingsPageConfig.js";

export interface SettingsSearchIndexEntry {
  /** 稳定 ID：分区项为 `${sectionId}:__section`，设置项为 `${sectionId}:${itemId}`。 */
  id: string;
  sectionId: SettingsSectionId;
  title: string;
  sectionTitle: string;
  keywords: readonly string[];
  /** DOM 上的 `data-settings-search-target` 值；分区项回退到 `section:${id}`。 */
  targetId: string;
  isSectionEntry: boolean;
}

export interface CreateSettingsSearchIndexOptions {
  settingsSections: readonly SettingsSectionDefinition[];
  /** Web 不展示远程设备/数据同步，搜索索引也不能把它们漏出来。 */
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  /** 文案解析；组件传 intl.formatMessage，测试可传 `id => id`。 */
  translate: (id: string) => string;
}

export const SETTINGS_SEARCH_RESULT_LIMIT = 20;

/** 按当前平台可见性构建索引。 */
export function createSettingsSearchIndex({
  settingsSections,
  isDesktop = false,
  isMacDesktop = false,
  translate,
}: CreateSettingsSearchIndexOptions): SettingsSearchIndexEntry[] {
  const entries: SettingsSearchIndexEntry[] = [];

  for (const section of settingsSections) {
    if (!isSettingsSectionAvailable(section.id, isDesktop)) continue;

    const sectionTitle = translate(section.contentTitleId ?? section.titleId);
    entries.push({
      id: `${section.id}:__section`,
      sectionId: section.id,
      title: sectionTitle,
      sectionTitle,
      keywords: [
        translate(section.titleId),
        ...(section.searchKeywords ?? []),
      ],
      targetId: `section:${section.id}`,
      isSectionEntry: true,
    });

    for (const item of section.searchItems ?? []) {
      if (item.visibility === "macDesktop" && !isMacDesktop) continue;
      entries.push({
        id: `${section.id}:${item.id}`,
        sectionId: section.id,
        title: translate(item.titleId),
        sectionTitle,
        keywords: item.keywords ?? [],
        targetId: item.targetId ?? `section:${section.id}`,
        isSectionEntry: false,
      });
    }
  }

  return entries;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function scoreToken(entry: SettingsSearchIndexEntry, token: string): number {
  const title = normalizeSearchText(entry.title);
  const sectionTitle = normalizeSearchText(entry.sectionTitle);
  const keywords = entry.keywords.map(normalizeSearchText);

  if (title === token) return 1000;
  if (title.startsWith(token)) return 900;
  if (title.includes(token)) return 800;
  if (keywords.some((keyword) => keyword === token)) return 700;
  if (keywords.some((keyword) => keyword.startsWith(token))) return 600;
  if (keywords.some((keyword) => keyword.includes(token))) return 500;
  if (sectionTitle.includes(token)) return entry.isSectionEntry ? 300 : 200;
  return 0;
}

/**
 * 单个条目的匹配分数；多词查询要求每个词都命中。
 * 0 表示不匹配，分数越大越靠前。
 */
export function scoreSettingsSearchEntry(entry: SettingsSearchIndexEntry, query: string): number {
  const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  let total = 0;
  for (const token of tokens) {
    const score = scoreToken(entry, token);
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

/** 过滤 + 排序 + 截断；空查询返回空数组（不展示全量清单）。 */
export function searchSettingsIndex(
  index: readonly SettingsSearchIndexEntry[],
  query: string,
  limit = SETTINGS_SEARCH_RESULT_LIMIT,
): SettingsSearchIndexEntry[] {
  if (!normalizeSearchText(query)) return [];

  return index
    .map((entry) => ({ entry, score: scoreSettingsSearchEntry(entry, query) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(left.entry.isSectionEntry) - Number(right.entry.isSectionEntry) ||
        left.entry.title.localeCompare(right.entry.title),
    )
    .slice(0, Math.max(0, limit))
    .map(({ entry }) => entry);
}
