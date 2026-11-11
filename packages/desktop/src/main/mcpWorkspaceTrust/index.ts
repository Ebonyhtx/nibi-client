/**
 * 工作区 MCP 信任（Desktop Host 入口）。
 *
 * 实现在 `@nibi/services/node` 的 mcp-trust：远端工作区（SSH/WSL/Docker/Server remote）的
 * 信任记录与声明都在远端文件系统，远端 Host 必须复用同一份存储路径、摘要算法与 strict 解析，
 * 否则 UI 会把本机信任库当成远端结论。这里保留 desktop main 既有导入路径与类型出口。
 */
export {
  WORKSPACE_MCP_TRUST_STORE_FILE,
  WorkspaceMcpTrustStoreCorruptError,
  canonicalizeMcpDeclaration,
  computeWorkspaceMcpDeclarationDigest,
  createWorkspaceMcpTrustHost,
  createWorkspaceMcpTrustRegistry,
  decideWorkspaceMcpTrust,
  filterTrustedProjectMcpRecords,
  inspectWorkspaceMcpTrust,
  isWorkspaceRegisteredForMcpInspection,
  normalizeWorkspacePathForTrust,
  readWorkspaceMcpTrustStore,
  resolveUserHomeDir,
  resolveWorkspaceMcpTrustStorePath,
  stableStringify,
  writeWorkspaceMcpTrustDecision,
} from "@nibi/services/node";
export type {
  WorkspaceMcpTrustDecision,
  WorkspaceMcpTrustReasonCode,
  WorkspaceMcpTrustReview,
  WorkspaceMcpTrustReviewView,
  WorkspaceMcpTrustLoadResult,
} from "./contract.js";
export type {
  WorkspaceMcpRegistration,
  WorkspaceMcpTrustHost,
  WorkspaceMcpTrustInspectResult,
  WorkspaceMcpTrustRegistry,
  WorkspaceMcpTrustStoreLoad,
} from "./contract.js";
