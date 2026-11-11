import type {
  DataSyncContentHashesResult,
  DataSyncImportItem,
  DataSyncImportResult,
  DataSyncListResult,
  DataSyncWorkspaceMapping,
  RemoteSyncWriteAccessResult,
  SkillDataSyncPayload,
} from "@nibi/shared";

/**
 * 数据同步分类服务的统一形状（`docs/remote/data-sync.md`「统一的同步服务形状」）。
 * 两端注册同一实现：本机作为 source，远端作为 target；方向由调用方决定，服务不写死。
 *
 * 实现按分类落在本模块，由各分类现有服务组合：技能 `skill-sync`、MCP `mcp-sync`、
 * 命令 `commands`、钩子 `hooks`、子智能体 `subagents`。这些通道已在 source-settings
 * attachment 中暴露，因此不需要新增 RPC 通道。
 */
export interface IDataSyncCategoryService<TPayload> {
  listSyncItems(): Promise<DataSyncListResult>;
  /**
   * 返回指定 key 的内容哈希。目录类条目按「相对路径 + 字节」计算。
   * `targetHomeDir` / `workspace`：作为来源端计算时由调用方传入目标端事实。需要路径改写的
   * 分类（MCP）先把来源配置改写成目标端路径再计算，使两端可以直接比较；其他分类忽略。
   */
  getSyncContentHashes(params: {
    keys: string[];
    targetHomeDir?: string;
    workspace?: DataSyncWorkspaceMapping;
  }): Promise<DataSyncContentHashesResult>;
  /** 写入并删除一个标记文件；失败时整类不推送。 */
  checkSyncWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  /** 目录类返回归档字节；payload 仍列出全部选中项，子技能随父目录一起打包。 */
  exportSyncItems(params: {
    keys: string[];
    workspace?: DataSyncWorkspaceMapping;
  }): Promise<TPayload>;
  /** `items` 为每个 key 指定 createOnly 或 overwrite；只处理列出的 key，永不删除目标端独有条目。 */
  importSyncItems(params: {
    payload: TPayload;
    items: DataSyncImportItem[];
  }): Promise<DataSyncImportResult>;
}

/** 技能分类当前使用同一形状；单独命名便于调用方表达意图。 */
export type ISkillDataSyncMethods = IDataSyncCategoryService<SkillDataSyncPayload>;
