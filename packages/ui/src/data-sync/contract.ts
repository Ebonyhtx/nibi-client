import type { IServiceAccessor } from "@nibi/services";
import type {
  DataSyncBlockedReason,
  DataSyncImportMode,
  DataSyncImportStatus,
  DataSyncItemSignature,
} from "@nibi/shared";

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

export interface DataSyncSkillRow {
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
  /** 本机 SKILL.md 绝对路径。 */
  path?: string;
  /** 远端独有项：远端 SKILL.md 绝对路径。 */
  targetPath?: string;
  targetDirectoryName?: string;
  /** 来源端字节数，用于按批次导出。 */
  totalBytes: number;
  /** 父子技能：来源端最近的上级 key。 */
  parentKey?: string;
}

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
