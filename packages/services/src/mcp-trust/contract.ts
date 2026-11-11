/**
 * services-mcp-trust 对外契约：工作区 MCP 信任的存储、审核与准入。
 *
 * 每个 Environment 的 Host 是信任记录的唯一写入者；Rust 内核只读同一份用户域记录
 * （`<storage root>/security/workspace-mcp-trust-v1.json`）。调用方只需要这些类型：
 * 存储位置解析、声明审核、信任决定与装载过滤，其余（摘要算法、原子写、脱敏）是实现细节。
 */

import type {
  LoadCliMcpFromUserDirectoryResult,
  NativeMcpServerRecord,
  WorkspaceMcpTrustDecision,
  WorkspaceMcpTrustReview,
} from "@nibi/shared";
import type { WorkspaceMcpTrustRecord } from "./storeFile.js";

export type { WorkspaceMcpTrustDecision, WorkspaceMcpTrustReview } from "@nibi/shared";
export const SERVICES_MCP_TRUST_MODULE_ID = "services-mcp-trust" as const;

/** 审核/决定失败的原因码（与 shared `WorkspaceMcpTrustDecision` 同一联合）。 */
export type WorkspaceMcpTrustReasonCode = Extract<
  WorkspaceMcpTrustDecision,
  { accepted: false }
>["reasonCode"];

/**
 * 设置页展示用的 review 扩展。
 *
 * `declarationChanged` 由 Host 在读取用户域记录时计算：同一工作区/服务器还留着旧摘要，
 * 说明当前声明已变化，旧授权已失效。它是 Host 的读取结论，UI 不得自行比较/猜测。
 */
export interface WorkspaceMcpTrustReviewView extends WorkspaceMcpTrustReview {
  declarationChanged?: boolean;
}

/**
 * 目录读取结果 + Host 审核元数据。
 *
 * `trustReasonCode` 只在 Host 明确拒绝审核时出现（工作区未登记/离线），此时没有 review；
 * `unreviewable` 是无法归一化、必须按未信任处理的项目 server 名。
 */
export type WorkspaceMcpTrustLoadResult = Omit<
  LoadCliMcpFromUserDirectoryResult,
  "trust"
> & {
  trust?: Record<string, WorkspaceMcpTrustReviewView>;
  trustReasonCode?: WorkspaceMcpTrustReasonCode;
  unreviewable?: string[];
};

/** 一个已登记的工作区；`online=false` 时 fail closed（不读声明、不复用旧授权）。 */
export interface WorkspaceMcpRegistration {
  workspacePath: string;
  workspaceIdentity?: string;
  online: boolean;
}

/** A6：只有登记过的（本窗口真正打开过的）工作区才允许审核。 */
export interface WorkspaceMcpTrustRegistry {
  register(entry: WorkspaceMcpRegistration): void;
  unregister(workspacePath: string, workspaceIdentity?: string): void;
  resolve(workspacePath: string, workspaceIdentity?: string): WorkspaceMcpRegistration | undefined;
}

/** 一条审核结果；`trusted` 只对应当前精确摘要。 */
export interface WorkspaceMcpTrustInspectResult {
  reviews: Record<string, WorkspaceMcpTrustReviewView>;
  /** 无法归一化（不可审核）的项目 server 名：调用方必须按未信任处理。 */
  unreviewable: string[];
}

export type WorkspaceMcpTrustStoreLoad =
  | { status: "ok"; records: WorkspaceMcpTrustRecord[] }
  | { status: "missing" }
  | { status: "corrupt" };

export interface WorkspaceMcpTrustInspectInput {
  records: NativeMcpServerRecord[];
  workspacePath: string;
  workspaceIdentity?: string;
  storePath?: string;
  storageRoot?: string;
  registeredWorkspaces?: WorkspaceMcpTrustRegistry;
  online?: boolean;
}

export interface WorkspaceMcpTrustDecideInput {
  records: NativeMcpServerRecord[];
  workspacePath: string;
  workspaceIdentity?: string;
  serverName: string;
  declarationDigest: string;
  trusted: boolean;
  storePath?: string;
  storageRoot?: string;
  registeredWorkspaces?: WorkspaceMcpTrustRegistry;
  online?: boolean;
}

export interface WorkspaceMcpTrustFilterInput {
  records: NativeMcpServerRecord[];
  reviews: Record<string, WorkspaceMcpTrustReview>;
  unreviewable?: readonly string[];
}

/** 供 Host 装配与测试使用的窄接口（实现见 `index.ts` 的 `createWorkspaceMcpTrustHost`）。 */
export interface WorkspaceMcpTrustHost {
  resolveStorePath(options?: { storageRoot?: string }): Promise<string>;
  inspect(input: WorkspaceMcpTrustInspectInput): Promise<WorkspaceMcpTrustInspectResult>;
  decide(input: WorkspaceMcpTrustDecideInput): Promise<WorkspaceMcpTrustDecision>;
  filterTrustedRecords(input: WorkspaceMcpTrustFilterInput): NativeMcpServerRecord[];
}
