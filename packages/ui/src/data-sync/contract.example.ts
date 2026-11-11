/**
 * data-sync 标准调用示例：设备分组 → 两端 list/hashes → 纯函数比较 → 导出/预检/导入。
 * 安全点：远端独有项不进入 rows，import 只带用户勾选的 key；分类由 `category` 显式传入。
 */
import type { DataSyncListItem } from "@nibi/shared";
import type { DataSyncCategoryId, DataSyncRow } from "./contract.js";
import { compareCategoryRows, selectDataSyncHashRequests } from "./domain/compare.js";

export function exampleCompareCategory(params: {
  category: DataSyncCategoryId;
  sourceItems: readonly DataSyncListItem[];
  targetItems: readonly DataSyncListItem[];
  sourceHashes: Readonly<Record<string, string>>;
  targetHashes: Readonly<Record<string, string>>;
}): { rows: DataSyncRow[]; sourceKeys: string[]; targetKeys: string[] } {
  const requests = selectDataSyncHashRequests(params.sourceItems, params.targetItems);
  return {
    rows: compareCategoryRows({ ...params }),
    sourceKeys: requests.sourceKeys,
    targetKeys: requests.targetKeys,
  };
}

export function examplePushKeys(rows: readonly DataSyncRow[]): string[] {
  return rows.filter((row) => row.selectable && row.defaultSelected).map((row) => row.key);
}
