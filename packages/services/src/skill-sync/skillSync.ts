import type {
  SkillDataSyncPayload,
  SkillSyncArchiveExportResult,
  SkillSyncCandidateListResult,
  SkillSyncImportResult,
  SkillSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
} from "@nibi/shared";
import { ServiceChannels } from "@nibi/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { IDataSyncCategoryService } from "#src/data-sync/contract.js";

/**
 * 技能同步服务：旧的三段式弹窗方法 + 统一数据同步分类形状。
 * 数据同步方法（listSyncItems / getSyncContentHashes / checkSyncWriteAccess / exportSyncItems /
 * importSyncItems）由 data-sync-service 模块实现，经同一个 skill-sync 通道暴露给 source-settings
 * attachment；新增方法不另开通道，手机白名单沿用该通道的现状，后续扩类时统一切到独立通道。
 */
export interface ISkillSyncService extends IDataSyncCategoryService<SkillDataSyncPayload> {
  listLocalUserSkillCandidates(): Promise<SkillSyncCandidateListResult>;
  listRemoteUserSkillStatuses(params: {
    directoryNames: string[];
    skills?: Array<{
      directoryName: string;
      name: string;
    }>;
  }): Promise<SkillSyncRemoteStatusResult>;
  exportSkillsArchive(params: { skillIds: string[] }): Promise<SkillSyncArchiveExportResult>;
  checkRemoteUserSkillWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importSkillsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<SkillSyncImportResult>;
}

export const ISkillSyncService = createServiceDescriptor<ISkillSyncService>(
  ServiceChannels.SkillSync,
);
