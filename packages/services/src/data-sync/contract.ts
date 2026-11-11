import type {
  DataSyncContentHashesResult,
  DataSyncImportItem,
  DataSyncImportResult,
  DataSyncListResult,
  RemoteSyncWriteAccessResult,
  SkillDataSyncPayload,
} from "@nibi/shared";

/**
 * 数据同步分类服务的统一形状（`docs/remote/data-sync.md`「统一的同步服务形状」）。
 * 两端注册同一实现：本机作为 source，远端作为 target；方向由调用方决定，服务不写死。
 *
 * B1 试点只接入技能；实现见 `skillDataSync.ts`，由 `createSkillSyncService` 组合进
 * 现有 `skill-sync` 通道，经 source-settings attachment 暴露给数据同步页。
 */
export interface IDataSyncCategoryService<TPayload> {
  listSyncItems(): Promise<DataSyncListResult>;
  /** 返回指定 key 的内容哈希。目录类条目按「相对路径 + 字节」计算。 */
  getSyncContentHashes(params: { keys: string[] }): Promise<DataSyncContentHashesResult>;
  /** 写入并删除一个标记文件；失败时整类不推送。 */
  checkSyncWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  /** 目录类返回归档字节；payload 仍列出全部选中项，子技能随父目录一起打包。 */
  exportSyncItems(params: { keys: string[] }): Promise<TPayload>;
  /** `items` 为每个 key 指定 createOnly 或 overwrite；只处理列出的 key，永不删除目标端独有条目。 */
  importSyncItems(params: {
    payload: TPayload;
    items: DataSyncImportItem[];
  }): Promise<DataSyncImportResult>;
}

/** 技能分类当前使用同一形状；单独命名便于调用方表达意图。 */
export type ISkillDataSyncMethods = IDataSyncCategoryService<SkillDataSyncPayload>;
