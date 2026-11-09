import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID,
} from "@nibi/shared";

// 市场 id 的**唯一真源**在 @nibi/shared/plugin-marketplaces。
// 这里曾经复写一份 "nibi-official"，与共享常量 "nibi-official" 分叉：
// 结果是内置插件的 id 与图标/启用表对不上（图标回退成中性 Blocks），
// 而症状只是"图标不对"，没有任何报错——所以必须由常量收口，不许再写字面量。
export const NIBI_OFFICIAL_PLUGIN_MARKETPLACE = NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID;

/**
 * 默认启用的官方插件集合。**直接复用 @nibi/shared 的那一份**，不再在 services 里复写：
 * 这里原来抄了一份，四件套从 `document-skills` 拆成 documents/pdf/presentations/spreadsheets
 * 时没跟上，于是内置插件缓存兜底判成「默认关闭」——四件套的 visual-judge 子智能体在
 * 设置页一个都不出现（2026-11-09 真机）。同一份名单只许有一个真源；bootstrap 侧的
 * 「Settings 默认启用集合与 CLI 官方声明一致」单测机械对照另一头。
 */
export { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS };

export interface OfficialPluginCacheRoot {
  /** 缓存目录名，即官方插件 name。 */
  name: string;
  /** 数字感知降序后的可用版本目录，首项为最新版本。 */
  versionRoots: string[];
}

/**
 * 扫描 `<plugins storage>/cache/nibi-official/<name>/<version>/`。
 * 内置官方插件由 CLI seed 到这里、没有 installed_plugins.json 记录，services 只读安装记录时会漏掉它们。
 * 版本目录跳过 CLI 的备份 / seed 锁 / 临时目录，并按数字感知降序排序，与 CLI 回退选取一致。
 */
export async function scanOfficialPluginCacheRoots(
  pluginStorageRoot: string,
): Promise<OfficialPluginCacheRoot[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", NIBI_OFFICIAL_PLUGIN_MARKETPLACE);
  let pluginEntries;
  try {
    pluginEntries = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: OfficialPluginCacheRoot[] = [];
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory()) continue;
    const pluginDir = join(cacheRoot, pluginEntry.name);
    let versionEntries;
    try {
      versionEntries = await readdir(pluginDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const versionRoots = versionEntries
      .filter((entry) => entry.isDirectory() && !isTransientCacheEntryName(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) =>
        right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }),
      )
      .map((version) => join(pluginDir, version));
    if (versionRoots.length > 0) {
      roots.push({ name: pluginEntry.name, versionRoots });
    }
  }
  return roots.sort((left, right) => left.name.localeCompare(right.name));
}

function isTransientCacheEntryName(name: string): boolean {
  return name.includes(".backup") || name.includes(".seed-lock") || name.includes(".tmp-");
}
