/**
 * 标准调用：注入 runtime，避免测试读取当前进程。
 */
import {
  resolveMcpNodeFallbackProvider,
  type McpNodeFallbackRuntime,
} from "./contract.js";

export function exampleCliMcpNodeFallback(
  storageRoot: string,
  runtime: McpNodeFallbackRuntime,
) {
  return resolveMcpNodeFallbackProvider({ cliStorageRoot: storageRoot, runtime });
}
