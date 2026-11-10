/**
 * services-mcp-node-fallback 对外契约：Rust 内核 + 桌面 Electron 时，Host 生成 shim 目录并把
 * 目录与两个环境变量注入 agent 环境；Node 内核返回空对象（bootstrap 自己处理回退）。
 */
export type { McpNodeFallbackHostEnvInput } from "./index.js";
export { buildMcpNodeFallbackHostEnv } from "./index.js";
