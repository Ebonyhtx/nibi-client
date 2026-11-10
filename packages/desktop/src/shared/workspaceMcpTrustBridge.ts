/**
 * 设置页 → Desktop Host 的工作区 MCP 信任桥。
 *
 * 通道只承载「用户对当前行声明的显式决定」；Host 会重新读取项目声明并核对精确摘要，
 * 未登记工作区、离线和损坏存储都由 Host fail closed，renderer 不能提交信任记录本身。
 */

import type { WorkspaceMcpTrustDecision } from "@nibi/shared";

export const WORKSPACE_MCP_TRUST_DECIDE_CHANNEL = "nibi:workspace-mcp-trust-decide" as const;

export interface WorkspaceMcpTrustDecisionRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  serverName: string;
  /** 用户审核时看到的声明摘要；Host 重读后不匹配即拒绝。 */
  declarationDigest: string;
  trusted: boolean;
}

export interface WorkspaceMcpTrustDecisionResponse {
  decision: WorkspaceMcpTrustDecision;
}
