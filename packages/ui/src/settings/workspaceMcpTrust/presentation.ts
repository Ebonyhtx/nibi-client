/**
 * 设置页「工作区 MCP 信任」的纯展示判定。
 *
 * 所有状态都来自 Host：`trusted`、`declarationChanged`、`trustReasonCode` 与
 * `sourcePaths/display`。这里只做 UI 状态映射与短指纹截断，不比较声明、不推断信任。
 */

import type {
  WorkspaceMcpTrustReasonCode,
  WorkspaceMcpTrustReviewView,
} from "@/store/mcpStoreDesktop.js";

export type WorkspaceMcpTrustUiState = "trusted" | "pending" | "changed" | "unavailable";

export interface WorkspaceMcpTrustPresentation {
  state: WorkspaceMcpTrustUiState;
  badgeMessageId: string;
  hintMessageId?: string;
  reasonMessageId?: string;
  reasonCode?: WorkspaceMcpTrustReasonCode;
  canTrust: boolean;
  canRevoke: boolean;
  /** 声明摘要短指纹；没有 review 时为空串。 */
  fingerprint: string;
  /** Host 提供的完整摘要（用于 title，便于复制核对）。 */
  declarationDigest: string;
  sourcePaths: string[];
  display: string;
}

const DIGEST_FINGERPRINT_LENGTH = 12;

const REASON_MESSAGE_IDS: Record<WorkspaceMcpTrustReasonCode, string> = {
  workspace_mcp_declaration_changed: "settings.mcp.workspaceTrust.reason.declarationChanged",
  workspace_mcp_trust_unavailable: "settings.mcp.workspaceTrust.reason.unavailable",
  workspace_mcp_workspace_not_registered: "settings.mcp.workspaceTrust.reason.notRegistered",
  workspace_mcp_workspace_offline: "settings.mcp.workspaceTrust.reason.offline",
};

export const WORKSPACE_MCP_TRUST_UNREVIEWABLE_MESSAGE_ID =
  "settings.mcp.workspaceTrust.reason.unreviewable";
export const WORKSPACE_MCP_TRUST_UNKNOWN_MESSAGE_ID =
  "settings.mcp.workspaceTrust.reason.unknown";

/** 声明摘要短指纹：只截断 Host 给的 digest，不做任何重算。 */
export function shortenDeclarationDigest(
  declarationDigest: string,
  length: number = DIGEST_FINGERPRINT_LENGTH,
): string {
  const digest = declarationDigest.trim();
  if (!digest) return "";
  return digest.length <= length ? digest : digest.slice(0, length);
}

export function workspaceMcpTrustReasonMessageId(
  reasonCode: WorkspaceMcpTrustReasonCode,
): string {
  return REASON_MESSAGE_IDS[reasonCode];
}

export function resolveWorkspaceMcpTrustPresentation(input: {
  server: { name: string; scope: string; source: string };
  trustKnown: boolean;
  review?: WorkspaceMcpTrustReviewView;
  reasonCode?: WorkspaceMcpTrustReasonCode;
  unreviewable: readonly string[];
}): WorkspaceMcpTrustPresentation | null {
  const isProjectMcp =
    input.server.scope === "workspace" && input.server.source === "zcodeagentmcp";
  if (!isProjectMcp || !input.trustKnown) return null;

  if (input.review) {
    const fingerprint = shortenDeclarationDigest(input.review.declarationDigest);
    if (input.review.trusted) {
      return {
        state: "trusted",
        badgeMessageId: "settings.mcp.workspaceTrust.badge.trusted",
        hintMessageId: "settings.mcp.workspaceTrust.trustedHint",
        canTrust: false,
        canRevoke: true,
        fingerprint,
        declarationDigest: input.review.declarationDigest,
        sourcePaths: input.review.sourcePaths,
        display: input.review.display,
      };
    }
    if (input.review.declarationChanged) {
      return {
        state: "changed",
        badgeMessageId: "settings.mcp.workspaceTrust.badge.changed",
        hintMessageId: "settings.mcp.workspaceTrust.changedHint",
        reasonMessageId: REASON_MESSAGE_IDS.workspace_mcp_declaration_changed,
        reasonCode: "workspace_mcp_declaration_changed",
        canTrust: true,
        canRevoke: false,
        fingerprint,
        declarationDigest: input.review.declarationDigest,
        sourcePaths: input.review.sourcePaths,
        display: input.review.display,
      };
    }
    return {
      state: "pending",
      badgeMessageId: "settings.mcp.workspaceTrust.badge.pending",
      hintMessageId: "settings.mcp.workspaceTrust.effectiveAfterTrust",
      canTrust: true,
      canRevoke: false,
      fingerprint,
      declarationDigest: input.review.declarationDigest,
      sourcePaths: input.review.sourcePaths,
      display: input.review.display,
    };
  }

  if (input.unreviewable.includes(input.server.name)) {
    return {
      state: "unavailable",
      badgeMessageId: "settings.mcp.workspaceTrust.badge.unavailable",
      reasonMessageId: WORKSPACE_MCP_TRUST_UNREVIEWABLE_MESSAGE_ID,
      canTrust: false,
      canRevoke: false,
      fingerprint: "",
      declarationDigest: "",
      sourcePaths: [],
      display: "",
    };
  }

  return {
    state: "unavailable",
    badgeMessageId: "settings.mcp.workspaceTrust.badge.unavailable",
    reasonMessageId: input.reasonCode
      ? REASON_MESSAGE_IDS[input.reasonCode]
      : WORKSPACE_MCP_TRUST_UNKNOWN_MESSAGE_ID,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    canTrust: false,
    canRevoke: false,
    fingerprint: "",
    declarationDigest: "",
    sourcePaths: [],
    display: "",
  };
}
