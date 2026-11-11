import type { IServiceAccessor } from "@nibi/services";
import type {
  DataSyncBlockedReason,
  DataSyncImportMode,
  DataSyncImportStatus,
  DataSyncItemDependencies,
  DataSyncItemSignature,
} from "@nibi/shared";

/** 设置页数据同步支持的用户级分类；顺序即标签栏与概览的展示顺序。 */
export type DataSyncCategoryId = "skills" | "mcp" | "commands" | "hooks" | "subagents";

export const DATA_SYNC_CATEGORIES: readonly DataSyncCategoryId[] = [
  "skills",
  "mcp",
  "commands",
  "hooks",
  "subagents",
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
 * 通用同步行：五种分类共用同一形状，`category` 决定服务、文案与行内提示。
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

export type DataSyncPagePhase = "loading" | "ready" | "connecting" | "offline" | "error";

/** 页面唯一需要的两端服务：本机 base services 与设备的 source-settings attachment。 */
export interface DataSyncServices {
  source: IServiceAccessor | undefined;
  target: IServiceAccessor | undefined;
}
