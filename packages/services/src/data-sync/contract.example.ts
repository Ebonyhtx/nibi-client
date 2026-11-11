/**
 * data-sync-service 标准调用示例：服务实现统一分类形状；比较与默认勾选由 UI 纯函数完成。
 */
import type { DataSyncImportItem } from "@nibi/shared";
import type { IDataSyncCategoryService } from "./contract.js";
import { createSkillDataSyncMethods } from "./node.js";

export async function examplePushSkills(
  service: IDataSyncCategoryService<unknown>,
  keys: string[],
  items: DataSyncImportItem[],
) {
  const listed = await service.listSyncItems();
  const hashes = await service.getSyncContentHashes({ keys });
  const access = await service.checkSyncWriteAccess();
  if (!access.ok) return { access, created: 0 };
  const payload = await service.exportSyncItems({ keys });
  return {
    listed,
    hashes,
    access,
    payload,
    result: await service.importSyncItems({ payload, items }),
  };
}

export function exampleCreateSkillService() {
  return createSkillDataSyncMethods({ maxItemBytes: 20 * 1024 * 1024 });
}
