/**
 * cli-mcp-node-fallback 对外契约：只有 agent 自己跑在 Electron Node 上时才提供 provider；
 * 纯 Node CLI、SEA 与远端返回 undefined。
 */
export type {
  McpNodeFallbackRuntime,
  ResolveMcpNodeFallbackProviderOptions,
} from "./index.js";
export {
  bundledNpmRootCandidates,
  resolveMcpNodeFallbackProvider,
} from "./index.js";
