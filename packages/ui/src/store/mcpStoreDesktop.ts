import type {
  IPlatformService,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  SaveCliMcpToUserDirectoryRequest,
  WorkspaceMcpTrustDecision,
  WorkspaceMcpTrustReview,
} from "@nibi/shared";
import type { IMcpSyncService } from "@nibi/services";
import { logger } from "@/logger.js";

/** Host 审核/决定失败的原因码（与 shared 决定联合一致）。 */
export type WorkspaceMcpTrustReasonCode = Extract<
  WorkspaceMcpTrustDecision,
  { accepted: false }
>["reasonCode"];

const WORKSPACE_MCP_TRUST_REASON_CODES: ReadonlySet<string> = new Set([
  "workspace_mcp_declaration_changed",
  "workspace_mcp_trust_unavailable",
  "workspace_mcp_workspace_not_registered",
  "workspace_mcp_workspace_offline",
]);

/**
 * Host review 的展示扩展：`declarationChanged` 由 Host 计算（存在旧摘要记录），
 * UI 只读展示，不自行比较 digest。
 */
export interface WorkspaceMcpTrustReviewView extends WorkspaceMcpTrustReview {
  declarationChanged?: boolean;
}

/**
 * 目录读取结果 + Host 审核元数据。远端/旧 Host 可能没有这些字段；
 * 旧 Host 缺 `trust` 时保持 `workspaceTrustKnown=false` 的兼容语义。
 */
export type WorkspaceMcpTrustLoadResult = Omit<
  LoadCliMcpFromUserDirectoryResult,
  "trust"
> & {
  trust?: Record<string, WorkspaceMcpTrustReviewView>;
  trustReasonCode?: WorkspaceMcpTrustReasonCode;
  unreviewable?: string[];
};

export interface WorkspaceMcpTrustDecisionRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  serverName: string;
  declarationDigest: string;
  trusted: boolean;
}

/** Desktop Host 暴露的可选桥；Web/旧 Host 缺失时 UI 按 trust_unavailable 处理。 */
export interface WorkspaceMcpTrustPlatformBridge {
  decideWorkspaceMcpTrust?(
    request: WorkspaceMcpTrustDecisionRequest,
  ): Promise<WorkspaceMcpTrustDecision>;
}

export type McpPlatformService = Pick<
  IPlatformService,
  "loadMcpFromUserDirectory" | "saveMcpToUserDirectory"
> &
  WorkspaceMcpTrustPlatformBridge;

export type McpDirectoryService = Pick<
  IMcpSyncService,
  "loadMcpFromUserDirectory" | "saveMcpToUserDirectory"
>;

export async function persistCliMcpToUserDirectory(
  platform: McpPlatformService | null,
  payload: SaveCliMcpToUserDirectoryRequest,
  directoryService?: McpDirectoryService | null,
): Promise<boolean> {
  if (directoryService) {
    await directoryService.saveMcpToUserDirectory(payload);
    return true;
  }
  if (!platform?.saveMcpToUserDirectory) {
    logger.warn(
      "[mcpStore] platform MCP save unavailable, skip persisting CLI MCP to user directory",
    );
    return false;
  }

  const result = await platform.saveMcpToUserDirectory(payload);
  if (!result?.success) {
    throw new Error(result?.error ?? "Failed to persist MCP config");
  }
  return true;
}

export async function fetchNativeMcpServers(
  platform: McpPlatformService | null,
  payload?: LoadCliMcpFromUserDirectoryRequest,
  directoryService?: McpDirectoryService | null,
): Promise<WorkspaceMcpTrustLoadResult> {
  if (directoryService) {
    return (await directoryService.loadMcpFromUserDirectory(payload)) as WorkspaceMcpTrustLoadResult;
  }
  if (!platform?.loadMcpFromUserDirectory) {
    return { servers: [] };
  }
  return (await platform.loadMcpFromUserDirectory(payload)) as WorkspaceMcpTrustLoadResult;
}

function isWorkspaceMcpTrustDecision(value: unknown): value is WorkspaceMcpTrustDecision {
  if (typeof value !== "object" || value === null) return false;
  const decision = value as { accepted?: unknown; reasonCode?: unknown };
  if (decision.accepted === true) return true;
  return (
    decision.accepted === false &&
    typeof decision.reasonCode === "string" &&
    WORKSPACE_MCP_TRUST_REASON_CODES.has(decision.reasonCode)
  );
}

/**
 * 通过 Desktop Host 提交一次显式决定。桥缺失、抛错或返回形状不对一律按
 * `workspace_mcp_trust_unavailable` 处理（fail closed，不本地推断已信任）。
 */
export async function decideWorkspaceMcpTrustThroughPlatform(
  platform: McpPlatformService | null,
  request: WorkspaceMcpTrustDecisionRequest,
): Promise<WorkspaceMcpTrustDecision> {
  if (!platform?.decideWorkspaceMcpTrust) {
    return { accepted: false, reasonCode: "workspace_mcp_trust_unavailable" };
  }
  try {
    const decision = await platform.decideWorkspaceMcpTrust(request);
    if (isWorkspaceMcpTrustDecision(decision)) {
      return decision;
    }
    return { accepted: false, reasonCode: "workspace_mcp_trust_unavailable" };
  } catch (error) {
    logger.warn("[mcpStore] workspace MCP trust decision failed", String(error));
    return { accepted: false, reasonCode: "workspace_mcp_trust_unavailable" };
  }
}
