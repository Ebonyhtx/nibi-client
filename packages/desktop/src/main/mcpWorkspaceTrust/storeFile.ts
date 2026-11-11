/**
 * 工作区 MCP trust store 文件格式。
 *
 * 实现与 Rust 内核 strict 解析的同一份代码位于 `@nibi/services/node`（mcp-trust/storeFile）；
 * 这里只保留 desktop main 既有导入路径，避免 Host 与远端各自维护一份 schema。
 */
export {
  WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION,
  parseWorkspaceMcpTrustStoreContent,
  parseWorkspaceMcpTrustStoreObject,
} from "@nibi/services/node";
export type {
  WorkspaceMcpTrustRecord,
  WorkspaceMcpTrustStoreFile,
  WorkspaceMcpTrustStoreParseResult,
} from "@nibi/services/node";
