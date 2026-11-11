export interface RemoteSyncWriteAccessResult {
  ok: boolean;
  path: string;
  error?: string;
}

/**
 * 数据同步（`docs/remote/data-sync.md`）各分类共用的服务形状。
 * 两端实现同一组方法，Renderer 按分类分派；比较逻辑在 Renderer 纯函数中完成。
 */

/** 条目不能参与同步的原因。exportBlockedReason 由来源端判定，overwriteBlockedReason 由目标端判定。 */
export type DataSyncBlockedReason =
  | "size-limit"
  | "contains-symlink"
  | "target-symlink"
  | "compat-directory";

/** 轻量签名：文件数 + 总字节。不同即判为内容不同，相同时才计算全量哈希。 */
export interface DataSyncItemSignature {
  fileCount: number;
  totalBytes: number;
}

export interface DataSyncListItem {
  /** 对齐 key，两端相同即视为同一项。 */
  key: string;
  name: string;
  description?: string;
  /** 只有带可靠版本来源的条目才有（例如商店安装元数据）。 */
  version?: string;
  signature?: DataSyncItemSignature;
  /** JSON 类条目哈希很便宜，可以直接在 list 中返回；目录类留空，按需调用 contentHashes。 */
  contentHash?: string;
  enabled: boolean;
  /** 技能分类：技能相对用户技能根的目录，例如 `group/review`。 */
  directoryName?: string;
  /** 技能分类：本端 SKILL.md 的绝对路径，用于行内展示。 */
  path?: string;
  /** 作为来源时不能导出的原因。 */
  exportBlockedReason?: DataSyncBlockedReason;
  /** 作为目标时不能被覆盖的原因。 */
  overwriteBlockedReason?: DataSyncBlockedReason;
  /**
   * 技能分类：同一端内、目录包含本条目目录的最近一个技能的 key。
   * 父子技能同时推送时，弹窗据此把子技能与最上层的已选上级放进同一批。
   */
  parentKey?: string;
}

export interface DataSyncListResult {
  items: DataSyncListItem[];
  homeDir: string;
  /** 作为目标时整类不能导入的原因；有值时该分类所有行都不可选。 */
  importBlockedReason?: DataSyncBlockedReason;
}

export interface DataSyncContentHashesResult {
  /** 只包含仍然存在且能计算的 key。 */
  hashes: Record<string, string>;
}

export type DataSyncImportMode = "createOnly" | "overwrite";

export interface DataSyncImportItem {
  key: string;
  mode: DataSyncImportMode;
  /** overwrite 时必填：列表加载时目标项的内容哈希，导入前重新计算，不一致返回 conflict。 */
  expectedTargetHash?: string;
}

export type DataSyncImportStatus = "created" | "updated" | "skipped" | "conflict" | "failed";

export interface DataSyncImportResultItem {
  key: string;
  status: DataSyncImportStatus;
  error?: string;
}

export interface DataSyncImportResult {
  results: DataSyncImportResultItem[];
}

/** 数据同步：技能 export 的结果，也是 import 的输入。 */
export interface SkillDataSyncPayload {
  archive: Uint8Array;
  sourceHomeDir: string;
  items: Array<{
    key: string;
    name: string;
    /** 归档内的相对目录，即来源端相对技能根的目录。 */
    directoryName: string;
    enabled: boolean;
  }>;
}
