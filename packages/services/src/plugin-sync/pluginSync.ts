import type {
  PluginDataSyncPayload,
  PluginSyncArchiveExportResult,
  PluginSyncCandidateListResult,
  PluginSyncImportResult,
  PluginSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
} from "@nibi/shared";
import { ServiceChannels } from "@nibi/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { IDataSyncCategoryService } from "../data-sync/contract.js";

/**
 * 数据同步使用 IDataSyncCategoryService 的统一形状（inline 插件，key 为 `name@inline` 转小写，
 * payload 中的 `pluginId` 保留大小写）。marketplace 插件重装仍走原有插件同步弹窗。
 */
export interface IPluginSyncService extends IDataSyncCategoryService<PluginDataSyncPayload> {
  listLocalUserPluginCandidates(): Promise<PluginSyncCandidateListResult>;
  listRemoteUserPluginStatuses(params: {
    plugins: Array<{
      pluginId: string;
      directoryName: string;
    }>;
  }): Promise<PluginSyncRemoteStatusResult>;
  exportPluginsArchive(params: { pluginIds: string[] }): Promise<PluginSyncArchiveExportResult>;
  exportMarketplaceSourceArchive(params: {
    marketplaceId: string;
    pluginNames: string[];
    source: Record<string, unknown>;
  }): Promise<{
    archive: Uint8Array;
    archiveBytes: number;
    marketplaceId: string;
    pluginNames: string[];
  }>;
  importPluginsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<PluginSyncImportResult>;
  checkRemoteUserPluginWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importMarketplaceSourceArchive(params: { archive: Uint8Array; overwrite?: false }): Promise<{
    marketplaceId: string;
    path: string;
    status: "skipped" | "synced";
  }>;
}

export const IPluginSyncService = createServiceDescriptor<IPluginSyncService>(
  ServiceChannels.PluginSync,
);
