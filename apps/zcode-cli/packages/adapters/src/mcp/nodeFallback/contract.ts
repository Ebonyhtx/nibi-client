/**
 * adapters-mcp-node-fallback 对外契约：调用方只需要知道「准备 shim 目录 → 把目录与两个变量交给
 * MCP 子进程」这一条链路。具体 shim 文本与平台差异属于实现。
 */
export type {
  CreateMcpNodeFallbackProviderOptions,
  McpNodeFallback,
  McpNodeFallbackProvider,
} from "./index.js";
export { applyMcpNodeFallbackEnv } from "./index.js";
