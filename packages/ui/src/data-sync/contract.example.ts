/**
 * data-sync 标准调用示例：设备分组 → 两端 list/hashes → 纯函数比较 → 导出/预检/导入。
 * 安全点：远端独有项不进入 rows，import 只带用户勾选的 key。
 */
import type { DataSyncListItem, SkillDataSyncPayload } from "@nibi/shared";
import type { DataSyncSkillRow } from "./contract.js";
import { compareSkillRows, selectSkillHashRequests } from "./domain/compare.js";

export function exampleCompareSkills(params: {
  sourceItems: readonly DataSyncListItem[];
  targetItems: readonly DataSyncListItem[];
  sourceHashes: Readonly<Record<string, string>>;
  targetHashes: Readonly<Record<string, string>>;
}): { rows: DataSyncSkillRow[]; sourceKeys: string[]; targetKeys: string[] } {
  const requests = selectSkillHashRequests(params.sourceItems, params.targetItems);
  return {
    rows: compareSkillRows({ ...params }),
    sourceKeys: requests.sourceKeys,
    targetKeys: requests.targetKeys,
  };
}

export function examplePushKeys(rows: readonly DataSyncSkillRow[]): string[] {
  return rows.filter((row) => row.selectable && row.defaultSelected).map((row) => row.key);
}

export type ExampleSkillPayload = SkillDataSyncPayload;
