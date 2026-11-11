import type { IServiceAccessor } from "@nibi/services";
import type {
  DataSyncBlockedReason,
  DataSyncImportMode,
  DataSyncImportStatus,
  DataSyncItemDependencies,
  DataSyncItemSignature,
} from "@nibi/shared";

// UI 层不能直接依赖 Service 实现；门禁错误码经本模块 contract 转发，页面只认这里。
export {
  DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE,
  DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE,
} from "@nibi/services";

/** 设置页数据同步支持的用户级分类；顺序即标签栏与概览的展示顺序。 */
export type DataSyncCategoryId = "skills" | "mcp" | "commands" | "hooks" | "subagents" | "plugins";

export const DATA_SYNC_CATEGORIES: readonly DataSyncCategoryId[] = [
  "skills",
  "mcp",
  "commands",
  "hooks",
  "subagents",
  "plugins",
];

/** 概览计数：本机条目数、远端条目数、需要推送的条目数（可勾选行）。 */
export interface DataSyncCategoryCounts {
  sourceCount: number;
  targetCount: number;
  changedCount: number;
}

/** 数据同步页可选的远端设备：只列出在线、且该平台能申请 source-settings attachment 的「用户」目标。 */
export interface DataSyncDevice {
  sourceServerId: string;
  name: string;
}

/** 行状态：推送 / 更新 / 差异 / 已同步 / 远端独有 / 不可同步。远端独有项不进入推送，也不删除。 */
export type DataSyncRowStatus =
  | "push"
  | "update"
  | "difference"
  | "synced"
  | "remoteOnly"
  | "blocked";

export type DataSyncRowNote =
  | { kind: "sourceOnly" }
  | { kind: "version"; from: string; to: string }
  | { kind: "sourceOlder" }
  | { kind: "contentDiffers" }
  | { kind: "synced" }
  | { kind: "remoteOnly" }
  | { kind: "blocked"; reason: DataSyncBlockedReason };

/**
 * 通用同步行：六种分类共用同一形状，`category` 决定服务、文案与行内提示。
 * 技能特有的字段（`directoryName` / `parentKey` / 版本）在其他分类留空。
 */
export interface DataSyncRow {
  category: DataSyncCategoryId;
  key: string;
  name: string;
  description?: string;
  status: DataSyncRowStatus;
  note: DataSyncRowNote;
  selectable: boolean;
  defaultSelected: boolean;
  importMode?: DataSyncImportMode;
  expectedTargetHash?: string;
  sourceSignature?: DataSyncItemSignature;
  targetSignature?: DataSyncItemSignature;
  directoryName?: string;
  /** 本机条目路径（技能 / 命令 / 子智能体）。 */
  path?: string;
  /** 远端独有项：远端条目路径。 */
  targetPath?: string;
  targetDirectoryName?: string;
  /** 来源端字节数，用于按批次导出。 */
  totalBytes: number;
  /** 父子技能：来源端最近的上级 key。 */
  parentKey?: string;
  /** 子智能体分类：引用的 MCP / 技能名称，只做行内提示，不影响行状态与勾选。 */
  dependencies?: DataSyncItemDependencies;
}

/** 兼容旧导出与既有测试：技能行就是带 `category: "skills"` 的通用行。 */
export type DataSyncSkillRow = DataSyncRow;

export type DataSyncPushStatus = DataSyncImportStatus;

export interface DataSyncPushOutcome {
  key: string;
  status: DataSyncPushStatus;
  error?: string;
}

export interface DataSyncPushSummary {
  succeeded: number;
  failed: number;
  skipped: number;
  outcomes: Readonly<Record<string, DataSyncPushOutcome>>;
}

export interface DataSyncPushFailure {
  key: string;
  name: string;
  status: Extract<DataSyncPushStatus, "failed" | "conflict">;
  error?: string;
}

/**
 * 单分类一次推送的结果快照。
 *
 * 由 `useDataSyncCategory` 在推送结束时直接返回，而不是让概览去读 React state：
 * 「推送全部」并行推进多个分类时，state 更新是异步的，读 state 会拿到上一帧。
 * 分类级失败（能力门禁 / 写权限预检 / 导出导入抛错）时 `failed` 等于本次尝试的条目数，
 * `failures` 只保留已经拿到逐项结果的失败项。
 */
export interface DataSyncCategoryPushResult {
  category: DataSyncCategoryId;
  /** 本次实际尝试推送的条目数（筛选后的可勾选行）。 */
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  failures: DataSyncPushFailure[];
  /** 分类级失败原因；逐项失败时为空。 */
  error?: string;
  /** 分类级失败的稳定错误码（能力门禁），UI 据此选 i18n 文案。 */
  errorCode?: string;
}

/** 概览「推送全部」的汇总；`results` 按分类固定顺序保留每个分类的结果。 */
export interface DataSyncPushAllSummary {
  succeeded: number;
  failed: number;
  skipped: number;
  results: DataSyncCategoryPushResult[];
}

export type DataSyncPagePhase = "loading" | "ready" | "connecting" | "offline" | "error";

/** 页面唯一需要的两端服务：本机 base services 与设备的 source-settings attachment。 */
export interface DataSyncServices {
  source: IServiceAccessor | undefined;
  target: IServiceAccessor | undefined;
}
